use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ReportStatus {
    Draft,
    Submitted,
    Triaged,
    Verified,
    Rejected,
    Published,
}

impl ReportStatus {
    pub fn as_db_str(&self) -> &'static str {
        match self {
            Self::Draft => "DRAFT",
            Self::Submitted => "SUBMITTED",
            Self::Triaged => "TRIAGED",
            Self::Verified => "VERIFIED",
            Self::Rejected => "REJECTED",
            Self::Published => "PUBLISHED",
        }
    }

    pub fn from_db_str(value: &str) -> Result<Self, DomainError> {
        match value {
            "DRAFT" => Ok(Self::Draft),
            "SUBMITTED" => Ok(Self::Submitted),
            "TRIAGED" => Ok(Self::Triaged),
            "VERIFIED" => Ok(Self::Verified),
            "REJECTED" => Ok(Self::Rejected),
            "PUBLISHED" => Ok(Self::Published),
            _ => Err(DomainError::UnknownStatus),
        }
    }

    pub fn parse_canonical(value: &str) -> Result<Self, DomainError> {
        Self::from_db_str(&value.trim().to_ascii_uppercase())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Report {
    pub id: uuid::Uuid,
    pub category: String,
    pub description: String,
    pub status: ReportStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum VerificationAction {
    Submit,
    Triage,
    Verify,
    Reject,
    Publish,
}

impl VerificationAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Submit => "SUBMIT",
            Self::Triage => "TRIAGE",
            Self::Verify => "VERIFY",
            Self::Reject => "REJECT",
            Self::Publish => "PUBLISH",
        }
    }

    pub fn parse_canonical(value: &str) -> Result<Self, DomainError> {
        match value.trim().to_ascii_uppercase().as_str() {
            "SUBMIT" => Ok(Self::Submit),
            "TRIAGE" => Ok(Self::Triage),
            "VERIFY" => Ok(Self::Verify),
            "REJECT" => Ok(Self::Reject),
            "PUBLISH" => Ok(Self::Publish),
            _ => Err(DomainError::UnknownAction),
        }
    }
}

#[derive(Debug, Error)]
pub enum DomainError {
    #[error("invalid report transition from {from:?} via {action:?}")]
    InvalidTransition {
        from: ReportStatus,
        action: VerificationAction,
    },
    #[error("unknown report status")]
    UnknownStatus,
    #[error("unknown verification action")]
    UnknownAction,
}

impl Report {
    pub fn new(id: uuid::Uuid, category: String, description: String) -> Self {
        Self {
            id,
            category,
            description,
            status: ReportStatus::Draft,
        }
    }

    pub fn apply(&mut self, action: VerificationAction) -> Result<(), DomainError> {
        self.status = transition(self.status.clone(), action)?;
        Ok(())
    }
}

pub fn transition(
    current: ReportStatus,
    action: VerificationAction,
) -> Result<ReportStatus, DomainError> {
    match (current.clone(), action) {
        (ReportStatus::Draft, VerificationAction::Submit) => Ok(ReportStatus::Submitted),
        (ReportStatus::Submitted, VerificationAction::Triage) => Ok(ReportStatus::Triaged),
        (ReportStatus::Triaged, VerificationAction::Verify) => Ok(ReportStatus::Verified),
        (ReportStatus::Submitted, VerificationAction::Reject) => Ok(ReportStatus::Rejected),
        (ReportStatus::Triaged, VerificationAction::Reject) => Ok(ReportStatus::Rejected),
        (ReportStatus::Verified, VerificationAction::Publish) => Ok(ReportStatus::Published),
        (_, action) => Err(DomainError::InvalidTransition {
            from: current,
            action,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::{transition, ReportStatus, VerificationAction};

    #[test]
    fn report_happy_path() {
        let status = transition(ReportStatus::Draft, VerificationAction::Submit)
            .and_then(|s| transition(s, VerificationAction::Triage))
            .and_then(|s| transition(s, VerificationAction::Verify))
            .and_then(|s| transition(s, VerificationAction::Publish))
            .expect("transition chain should be valid");

        assert_eq!(status, ReportStatus::Published);
    }

    #[test]
    fn rejects_invalid_transition() {
        let result = transition(ReportStatus::Draft, VerificationAction::Publish);
        assert!(result.is_err());
    }

    #[test]
    fn can_reject_after_triage() {
        let status = transition(ReportStatus::Triaged, VerificationAction::Reject)
            .expect("reject after triage should be valid");
        assert_eq!(status, ReportStatus::Rejected);
    }

    #[test]
    fn cannot_verify_without_triage() {
        let result = transition(ReportStatus::Submitted, VerificationAction::Verify);
        assert!(result.is_err());
    }

    #[test]
    fn canonical_parsing_handles_case_and_whitespace() {
        assert_eq!(
            ReportStatus::parse_canonical(" draft ").unwrap(),
            ReportStatus::Draft
        );
        assert_eq!(
            VerificationAction::parse_canonical("triage").unwrap(),
            VerificationAction::Triage
        );
        assert!(ReportStatus::parse_canonical("unknown").is_err());
        assert!(VerificationAction::parse_canonical("unknown").is_err());
    }
}
