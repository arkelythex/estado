use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEvent {
    pub id: uuid::Uuid,
    pub action: String,
    pub target_type: String,
    pub target_id: Option<String>,
    pub actor_id: Option<String>,
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuditChainInput {
    pub prev_hash: String,
    pub occurred_at: String,
    pub actor_type: String,
    pub actor_id: String,
    pub action: String,
    pub target_type: String,
    pub target_id: String,
    pub metadata_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuditChainEntry {
    pub seq_no: i64,
    pub prev_hash: String,
    pub event_hash: String,
    pub occurred_at: String,
    pub actor_type: String,
    pub actor_id: String,
    pub action: String,
    pub target_type: String,
    pub target_id: String,
    pub metadata_json: String,
}

impl From<&AuditChainEntry> for AuditChainInput {
    fn from(entry: &AuditChainEntry) -> Self {
        Self {
            prev_hash: entry.prev_hash.clone(),
            occurred_at: entry.occurred_at.clone(),
            actor_type: entry.actor_type.clone(),
            actor_id: entry.actor_id.clone(),
            action: entry.action.clone(),
            target_type: entry.target_type.clone(),
            target_id: entry.target_id.clone(),
            metadata_json: entry.metadata_json.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ChainVerification {
    pub valid: bool,
    pub checked_events: usize,
    pub head_hash: String,
    pub broken_at_seq: Option<i64>,
    pub reason: Option<&'static str>,
}

fn update_len_prefixed(hasher: &mut Sha256, value: &str) {
    let bytes = value.as_bytes();
    hasher.update((bytes.len() as u64).to_be_bytes());
    hasher.update(bytes);
}

pub fn compute_event_hash(input: &AuditChainInput) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"civictech-audit-v1");
    update_len_prefixed(&mut hasher, &input.prev_hash);
    update_len_prefixed(&mut hasher, &input.occurred_at);
    update_len_prefixed(&mut hasher, &input.actor_type);
    update_len_prefixed(&mut hasher, &input.actor_id);
    update_len_prefixed(&mut hasher, &input.action);
    update_len_prefixed(&mut hasher, &input.target_type);
    update_len_prefixed(&mut hasher, &input.target_id);
    update_len_prefixed(&mut hasher, &input.metadata_json);
    hex::encode(hasher.finalize())
}

pub fn verify_chain(entries: &[AuditChainEntry]) -> ChainVerification {
    if entries.is_empty() {
        return ChainVerification {
            valid: true,
            checked_events: 0,
            head_hash: GENESIS_HASH.to_string(),
            broken_at_seq: None,
            reason: None,
        };
    }

    for (idx, entry) in entries.iter().enumerate() {
        let expected_prev = if idx == 0 {
            GENESIS_HASH
        } else {
            entries[idx - 1].event_hash.as_str()
        };

        if entry.prev_hash != expected_prev {
            let reason = if idx == 0 {
                "invalid genesis prev_hash"
            } else {
                "broken prev_hash link"
            };
            return ChainVerification {
                valid: false,
                checked_events: idx + 1,
                head_hash: expected_prev.to_string(),
                broken_at_seq: Some(entry.seq_no),
                reason: Some(reason),
            };
        }

        let expected_hash = compute_event_hash(&AuditChainInput::from(entry));
        if entry.event_hash != expected_hash {
            return ChainVerification {
                valid: false,
                checked_events: idx + 1,
                head_hash: expected_prev.to_string(),
                broken_at_seq: Some(entry.seq_no),
                reason: Some("event_hash mismatch"),
            };
        }
    }

    let head_hash = entries
        .last()
        .map(|e| e.event_hash.clone())
        .unwrap_or_else(|| GENESIS_HASH.to_string());

    ChainVerification {
        valid: true,
        checked_events: entries.len(),
        head_hash,
        broken_at_seq: None,
        reason: None,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        compute_event_hash, verify_chain, AuditChainEntry, AuditChainInput, ChainVerification,
        GENESIS_HASH,
    };

    fn make_entry(
        seq_no: i64,
        prev_hash: &str,
        actor_id: &str,
        action: &str,
        metadata_json: &str,
    ) -> AuditChainEntry {
        let input = AuditChainInput {
            prev_hash: prev_hash.to_string(),
            occurred_at: format!("2026-03-01T1{seq_no}:00:00Z"),
            actor_type: "MODERATOR".to_string(),
            actor_id: actor_id.to_string(),
            action: action.to_string(),
            target_type: "REPORT".to_string(),
            target_id: "rep-1".to_string(),
            metadata_json: metadata_json.to_string(),
        };
        let event_hash = compute_event_hash(&input);
        AuditChainEntry {
            seq_no,
            prev_hash: input.prev_hash,
            event_hash,
            occurred_at: input.occurred_at,
            actor_type: input.actor_type,
            actor_id: input.actor_id,
            action: input.action,
            target_type: input.target_type,
            target_id: input.target_id,
            metadata_json: input.metadata_json,
        }
    }

    #[test]
    fn empty_chain_verifies_at_genesis() {
        assert_eq!(
            verify_chain(&[]),
            ChainVerification {
                valid: true,
                checked_events: 0,
                head_hash: GENESIS_HASH.to_string(),
                broken_at_seq: None,
                reason: None,
            }
        );
    }

    #[test]
    fn multi_event_valid_chain_verifies() {
        let e1 = make_entry(
            1,
            GENESIS_HASH,
            "anon-1",
            "SUBMIT_REPORT",
            r#"{"municipality_id":"muni-1"}"#,
        );
        let e2 = make_entry(
            2,
            &e1.event_hash,
            "mod-1",
            "TRIAGE_REPORT",
            r#"{"reason":"complete"}"#,
        );
        let e3 = make_entry(
            3,
            &e2.event_hash,
            "mod-2",
            "VERIFY_REPORT",
            r#"{"evidence_count":2}"#,
        );

        assert_eq!(e1.event_hash.len(), 64);
        assert_ne!(e1.event_hash, e2.event_hash);

        let result = verify_chain(&[e1, e2, e3.clone()]);
        assert_eq!(
            result,
            ChainVerification {
                valid: true,
                checked_events: 3,
                head_hash: e3.event_hash,
                broken_at_seq: None,
                reason: None,
            }
        );
    }

    #[test]
    fn tampered_action_or_metadata_is_detected() {
        let e1 = make_entry(
            1,
            GENESIS_HASH,
            "anon-1",
            "SUBMIT_REPORT",
            r#"{"municipality_id":"muni-1"}"#,
        );
        let mut e2 = make_entry(
            2,
            &e1.event_hash,
            "mod-1",
            "TRIAGE_REPORT",
            r#"{"reason":"complete"}"#,
        );
        e2.action = "PUBLISH_REPORT".to_string();

        let tampered_action = verify_chain(&[e1.clone(), e2]);
        assert!(!tampered_action.valid);
        assert_eq!(tampered_action.broken_at_seq, Some(2));
        assert_eq!(tampered_action.head_hash, e1.event_hash);
        assert!(tampered_action.reason.is_some());

        let mut e2_meta = make_entry(
            2,
            &e1.event_hash,
            "mod-1",
            "TRIAGE_REPORT",
            r#"{"reason":"complete"}"#,
        );
        e2_meta.metadata_json = r#"{"reason":"tampered"}"#.to_string();
        let tampered_meta = verify_chain(&[e1, e2_meta]);
        assert!(!tampered_meta.valid);
        assert_eq!(tampered_meta.broken_at_seq, Some(2));
        assert!(tampered_meta.reason.is_some());
    }

    #[test]
    fn broken_prev_hash_link_and_bad_genesis_are_detected() {
        let e1 = make_entry(1, GENESIS_HASH, "anon-1", "SUBMIT_REPORT", "{}");
        let e2_broken = make_entry(
            2,
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "mod-1",
            "TRIAGE_REPORT",
            "{}",
        );

        let res = verify_chain(&[e1.clone(), e2_broken]);
        assert!(!res.valid);
        assert_eq!(res.broken_at_seq, Some(2));
        assert_eq!(res.head_hash, e1.event_hash);
        assert_eq!(res.reason, Some("broken prev_hash link"));

        let bad_genesis = make_entry(
            1,
            "1111111111111111111111111111111111111111111111111111111111111111",
            "anon-1",
            "SUBMIT_REPORT",
            "{}",
        );
        let res_genesis = verify_chain(&[bad_genesis]);
        assert!(!res_genesis.valid);
        assert_eq!(res_genesis.broken_at_seq, Some(1));
        assert_eq!(res_genesis.head_hash, GENESIS_HASH);
        assert_eq!(res_genesis.reason, Some("invalid genesis prev_hash"));
    }

    #[test]
    fn field_boundary_collision_resistance() {
        let a = AuditChainInput {
            prev_hash: GENESIS_HASH.to_string(),
            occurred_at: "2026-03-01T10:00:00Z".to_string(),
            actor_type: "AB".to_string(),
            actor_id: "C".to_string(),
            action: "SUBMIT".to_string(),
            target_type: "REPORT".to_string(),
            target_id: "1".to_string(),
            metadata_json: "{}".to_string(),
        };
        let b = AuditChainInput {
            prev_hash: GENESIS_HASH.to_string(),
            occurred_at: "2026-03-01T10:00:00Z".to_string(),
            actor_type: "A".to_string(),
            actor_id: "BC".to_string(),
            action: "SUBMIT".to_string(),
            target_type: "REPORT".to_string(),
            target_id: "1".to_string(),
            metadata_json: "{}".to_string(),
        };

        assert_ne!(compute_event_hash(&a), compute_event_hash(&b));
        assert_eq!(compute_event_hash(&a), compute_event_hash(&a));
    }
}
