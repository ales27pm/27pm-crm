//
//  App27pmCRMUITests.swift
//  App27pmCRMUITests
//
//  Created by Rork on October 1, 2026.
//

import XCTest

final class App27pmCRMUITests: XCTestCase {

    override func setUpWithError() throws {
        // Put setup code here. This method is called before the invocation of each test method in the class.

        // In UI tests it is usually best to stop immediately when a failure occurs.
        continueAfterFailure = false

        // In UI tests it's important to set the initial state - such as interface orientation - required for your tests before they run. The setUp method is a good place to do this.
    }

    override func tearDownWithError() throws {
        // Put teardown code here. This method is called after the invocation of each test method in the class.
    }

    @MainActor
    func testExample() throws {
        // UI tests must launch the application that they test.
        let app = XCUIApplication()
        app.launch()

        // Use XCTAssert and related functions to verify your tests produce the correct results.
    }

    @MainActor
    func testQuarantinedAttachmentDisplaysPendingAnalysisStatus() throws {
        let app = XCUIApplication()
        app.launchArguments.append("-ui-test-attachment-quarantine")
        app.launch()

        let status = app.staticTexts["attachment-quarantine-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        XCTAssertEqual(status.label, "Analyse en attente")

        let blockedStatus = app.staticTexts["attachment-blocked-status"]
        XCTAssertTrue(blockedStatus.waitForExistence(timeout: 5))
        XCTAssertEqual(blockedStatus.label, "Fichier bloqué")
        XCTAssertNotEqual(status.label, blockedStatus.label)
    }

    @MainActor
    func testLaunchPerformance() throws {
        // This measures how long it takes to launch your application.
        measure(metrics: [XCTApplicationLaunchMetric()]) {
            XCUIApplication().launch()
        }
    }
}
