export const OUTREACH_CONTACT_COMPLIANCE_SQL = `SELECT contact.id AS contactId, contact.organization_id AS organizationId,
  contact.compliance_version AS complianceVersion, contact.validated_at AS validatedAt,
  contact.deleted_at AS deletedAt, contact.do_not_contact AS doNotContact,
  contact.do_not_call AS doNotCall, contact.unsubscribed_at AS unsubscribedAt,
  contact.role_relevance AS roleRelevance,
  contact.role_relevance_detail AS roleRelevanceDetail,
  contact.personal_data_category AS personalDataCategory,
  contact.qualification_mode AS qualificationMode,
  organization.deleted_at AS organizationDeletedAt,
  organization.do_not_contact AS organizationDoNotContact,
  compliance.id AS channelId, compliance.channel, compliance.address_normalized AS addressNormalized,
  compliance.provenance_type AS provenanceType, compliance.source_url AS sourceUrl,
  compliance.captured_at AS capturedAt, compliance.evidence_ref AS evidenceRef,
  compliance.lawful_basis AS lawfulBasis, compliance.basis_verified_by AS basisVerifiedBy,
  compliance.basis_verified_at AS basisVerifiedAt, compliance.basis_evidence_ref AS basisEvidenceRef,
  compliance.basis_expires_at AS basisExpiresAt,
  compliance.publication_by_recipient AS publicationByRecipient,
  compliance.publication_no_restriction AS publicationNoRestriction,
  compliance.publication_role_relevance AS publicationRoleRelevance,
  compliance.direct_disclosure_no_restriction AS directDisclosureNoRestriction,
  compliance.b2b_relationship_evidence AS b2bRelationshipEvidence,
  compliance.b2b_message_relevance AS b2bMessageRelevance,
  compliance.dncl_status AS dnclStatus, compliance.dncl_checked_at AS dnclCheckedAt,
  compliance.dncl_evidence_ref AS dnclEvidenceRef,
  compliance.recipient_timezone AS recipientTimezone, compliance.status,
  compliance.validated_at AS channelValidatedAt,
  (SELECT COUNT(*) FROM contact_suppressions suppression
    WHERE suppression.channel=compliance.channel
      AND suppression.address_normalized=compliance.address_normalized
      AND (suppression.scope='global' OR (suppression.scope='category' AND suppression.category='prospecting'))) AS suppressionCount
  FROM contact_channel_compliance compliance
  JOIN contacts contact ON contact.id=compliance.contact_id
  LEFT JOIN organizations organization ON organization.id=contact.organization_id
  WHERE compliance.channel=? AND contact.deleted_at IS NULL`;
