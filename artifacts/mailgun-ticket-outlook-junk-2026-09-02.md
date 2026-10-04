# Mailgun support ticket — Outlook.com junk placement

Status: submitted through the official Mailgun Help Center on 2026-09-02T11:44:13Z using ales27pm@hotmail.com. The form was accepted and redirected away from the request page; the confirmation email and numeric ticket ID are still pending.

## English version (recommended)

**Subject:** Outlook.com junk placement despite full authentication — shared IP reputation review requested (27pm.org / 159.135.228.14)

Hello Mailgun Support,

We are investigating the placement of a message sent through Mailgun from 27pm.org to a Microsoft mailbox that we control. Microsoft accepted the message on the first SMTP attempt, but routed it to Junk Email.

Message details:

- Sending domain: 27pm.org
- Mailgun shared sending IP: 159.135.228.14
- Controlled recipient: ales_27@hotmail.com
- Subject: S.Huot — à qui puis-je transmettre une courte analyse Web?
- Message-ID: `<20260902073531.11831a4fd0976c4b@27pm.org>`
- Received by Microsoft: 2026-09-02T07:35:36Z
- SMTP result: accepted on the first attempt

Relevant Microsoft authentication and filtering results:

- SPF: pass
- DKIM: pass
- DMARC: pass
- compauth: pass
- BCL: 0
- SCL: 6
- dest: J
- OFR: SpamFilterAuthJ
- RF: JunkEmail

Could you please:

1. Review the reputation and Microsoft-delivery telemetry for shared IP 159.135.228.14 around the timestamp above.
2. Inspect any Microsoft SNDS and JMRP signals available to Mailgun for this shared sending pool.
3. Confirm whether the pool showed any Microsoft-specific reputation or delivery anomaly that could explain this authenticated message receiving SCL 6.
4. Recommend a pool change, or move the domain to another appropriate shared pool, only if Mailgun’s telemetry indicates that the current pool is contributing to the placement problem.

We are not requesting a dedicated IP. We would first like an evidence-based assessment of the current shared pool.

Thank you.

## Version française

**Objet :** Classement indésirable Outlook.com malgré une authentification complète — demande d’inspection de l’IP partagée (27pm.org / 159.135.228.14)

Bonjour,

Nous examinons le classement d’un message envoyé par Mailgun depuis 27pm.org vers une boîte Microsoft que nous contrôlons. Microsoft a accepté le message dès la première tentative SMTP, mais l’a dirigé vers le courrier indésirable.

Détails du message :

- Domaine d’envoi : 27pm.org
- IP d’envoi Mailgun partagée : 159.135.228.14
- Destinataire contrôlé : ales_27@hotmail.com
- Objet : S.Huot — à qui puis-je transmettre une courte analyse Web?
- Message-ID : `<20260902073531.11831a4fd0976c4b@27pm.org>`
- Réception par Microsoft : 2026-09-02T07:35:36Z
- Résultat SMTP : accepté dès la première tentative

Résultats Microsoft pertinents d’authentification et de filtrage :

- SPF : pass
- DKIM : pass
- DMARC : pass
- compauth : pass
- BCL : 0
- SCL : 6
- dest : J
- OFR : SpamFilterAuthJ
- RF : JunkEmail

Pourriez-vous :

1. Examiner la réputation et la télémétrie de livraison Microsoft de l’IP partagée 159.135.228.14 autour de l’heure indiquée.
2. Vérifier les signaux Microsoft SNDS et JMRP dont Mailgun dispose pour ce bassin d’envoi partagé.
3. Confirmer si ce bassin présentait une anomalie de réputation ou de livraison propre à Microsoft pouvant expliquer l’attribution de SCL 6 à ce message pourtant authentifié.
4. Recommander un changement de bassin, ou déplacer le domaine vers un autre bassin partagé approprié, uniquement si la télémétrie de Mailgun indique que le bassin actuel contribue au problème de placement.

Nous ne demandons pas d’IP dédiée. Nous souhaitons d’abord une évaluation du bassin partagé actuel fondée sur la télémétrie.

Merci.
