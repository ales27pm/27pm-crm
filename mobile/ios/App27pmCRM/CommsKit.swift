import MessageUI
import SafariServices
import SwiftUI
import UIKit

// MARK: - SMS

/// System Messages composer. The message is only ever handed to Messages —
/// nothing is sent without the user's explicit send action in the system UI.
/// Use `canSendText` first; when false (simulator, no Messages account) the
/// caller shows a clean hint instead of a dead button.
struct SMSComposerView: UIViewControllerRepresentable {
  let recipients: [String]
  let body: String

  @Environment(\.dismiss) private var dismiss

  static var canSendText: Bool {
    MFMessageComposeViewController.canSendText()
  }

  func makeUIViewController(context: Context) -> MFMessageComposeViewController {
    let controller = MFMessageComposeViewController()
    controller.recipients = recipients
    controller.body = body
    controller.messageComposeDelegate = context.coordinator
    return controller
  }

  func updateUIViewController(_ uiViewController: MFMessageComposeViewController, context: Context) {}

  func makeCoordinator() -> Coordinator {
    Coordinator(dismiss: dismiss)
  }

  final class Coordinator: NSObject, MFMessageComposeViewControllerDelegate {
    let dismiss: DismissAction

    init(dismiss: DismissAction) {
      self.dismiss = dismiss
    }

    nonisolated func messageComposeViewController(
      _ controller: MFMessageComposeViewController,
      didFinishWith result: MessageComposeResult
    ) {
      Task { @MainActor in
        dismiss()
      }
    }
  }
}

// MARK: - In-app browser

/// In-app browser (https only) for source links. The device-authentication
/// flow deliberately does NOT use this — it keeps its system authentication
/// session unchanged.
struct InAppBrowserView: UIViewControllerRepresentable {
  let url: URL

  init?(url: URL) {
    guard url.scheme?.lowercased() == "https" else { return nil }
    self.url = url
  }

  func makeUIViewController(context: Context) -> SFSafariViewController {
    let controller = SFSafariViewController(url: url)
    controller.dismissButtonStyle = .close
    return controller
  }

  func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
}

// MARK: - Printing

@MainActor
enum DossierPrinter {
  /// Prints the dossier HTML through AirPrint. Nothing happens beyond the
  /// system print sheet if the user cancels.
  static func printDossier(html: String, jobName: String) {
    let controller = UIPrintInteractionController.shared
    let info = UIPrintInfo(dictionary: nil)
    info.outputType = .general
    info.jobName = jobName
    controller.printInfo = info
    let formatter = UIMarkupTextPrintFormatter(markupText: html)
    formatter.contentInsets = UIEdgeInsets(top: 36, left: 24, bottom: 36, right: 24)
    controller.printFormatter = formatter
    controller.present(animated: true)
  }
}

// MARK: - Dossier composition

/// Builds the shareable text and printable HTML for a 360° dossier, from
/// live data only — nothing is ever fabricated.
enum DossierComposer {
  static func text(
    organization: Organization,
    contacts: [Contact],
    deals: [Deal],
    address: String?
  ) -> String {
    var lines: [String] = []
    lines.append(organization.name)
    lines.append("Priorité : \(organization.priority.label) · Score : \(organization.score)")
    if let address, !address.trimmed.isEmpty {
      lines.append("Adresse : \(address)")
    }
    lines.append("Enveloppe indicative : \(Fmt.budgetRange(minCents: organization.budgetMinCents, maxCents: organization.budgetMaxCents))")
    if let nextStep = organization.nextStep, !nextStep.trimmed.isEmpty {
      lines.append("Prochaine étape : \(nextStep)")
    }
    if !contacts.isEmpty {
      lines.append("")
      lines.append("Contacts :")
      for contact in contacts {
        var line = "• \(contact.name) — \(contact.email)"
        if let phone = contact.phone, !phone.trimmed.isEmpty {
          line += " · \(phone)"
        }
        lines.append(line)
      }
    }
    if !deals.isEmpty {
      lines.append("")
      lines.append("Opportunités :")
      for deal in deals {
        lines.append("• \(deal.title) — \(deal.stage.label)")
      }
    }
    lines.append("")
    lines.append("Fiche générée par 27PM CRM")
    return lines.joined(separator: "\n")
  }

  static func html(
    organization: Organization,
    contacts: [Contact],
    deals: [Deal],
    address: String?
  ) -> String {
    let ink = "#171714"
    let muted = "#65625B"
    let blue = "#2846B8"
    let line = "rgba(23,23,20,0.16)"

    var rows: [String] = []
    rows.append("<h1 style='font-family:Georgia,serif;color:\(ink);font-size:24px;margin:0 0 4px;'>\(escape(organization.name))</h1>")
    rows.append("<p style='color:\(muted);font-size:12px;margin:0 0 14px;'>Dossier 360° · \(escape(organization.priority.label)) · Score \(organization.score)</p>")
    if let address, !address.trimmed.isEmpty {
      rows.append(section(title: "Adresse", body: "<p style='margin:0;'>\(escape(address))</p>"))
    }
    rows.append(
      section(
        title: "Enveloppe indicative",
        body: "<p style='margin:0;'>\(escape(Fmt.budgetRange(minCents: organization.budgetMinCents, maxCents: organization.budgetMaxCents)))</p>"
      )
    )
    if let nextStep = organization.nextStep, !nextStep.trimmed.isEmpty {
      rows.append(section(title: "Prochaine étape", body: "<p style='margin:0;'>\(escape(nextStep))</p>"))
    }
    if !organization.notes.trimmed.isEmpty {
      rows.append(section(title: "Notes", body: "<p style='margin:0;'>\(escape(organization.notes))</p>"))
    }
    if !contacts.isEmpty {
      var contactRows: [String] = []
      for contact in contacts {
        var detail = escape(contact.role)
        detail += " · \(escape(contact.email))"
        if let phone = contact.phone, !phone.trimmed.isEmpty {
          detail += " · \(escape(phone))"
        }
        contactRows.append(
          "<li style='margin-bottom:6px;'><strong>\(escape(contact.name))</strong><br><span style='color:\(muted);font-size:12px;'>\(detail)</span></li>"
        )
      }
      rows.append(section(title: "Contacts", body: "<ul style='margin:0;padding-left:18px;'>\(contactRows.joined())</ul>"))
    }
    if !deals.isEmpty {
      var dealRows: [String] = []
      for deal in deals {
        dealRows.append(
          "<li style='margin-bottom:6px;'><strong>\(escape(deal.title))</strong> — \(escape(deal.stage.label))</li>"
        )
      }
      rows.append(section(title: "Opportunités", body: "<ul style='margin:0;padding-left:18px;'>\(dealRows.joined())</ul>"))
    }

    return """
    <html><head><meta charset='utf-8'></head>
    <body style="font-family:-apple-system,'Helvetica Neue',sans-serif;color:\(ink);font-size:13px;line-height:1.45;">
    \(rows.joined())
    <p style="color:\(blue);font-size:10px;margin-top:22px;border-top:1px solid \(line);padding-top:8px;">Fiche générée par 27PM CRM</p>
    </body></html>
    """
  }

  private static func section(title: String, body: String) -> String {
    """
    <div style="margin-bottom:14px;">
      <div style="font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#65625B;margin-bottom:3px;">\(title)</div>
      \(body)
    </div>
    """
  }

  private static func escape(_ text: String) -> String {
    text
      .replacingOccurrences(of: "&", with: "&amp;")
      .replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
  }
}
