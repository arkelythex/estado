use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

pub const DEFAULT_THRESHOLD_CENTS: i64 = 4_280_000;
const CONCENTRATION_THRESHOLD_PCT: i128 = 70;
const BPS_SCALE: i128 = 10_000;

#[derive(Debug, PartialEq, Eq)]
pub enum AnomalyError {
    InvalidThreshold,
    InvalidAmount,
    AmountOverflow,
}

impl fmt::Display for AnomalyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidThreshold => f.write_str("invalid threshold_cents"),
            Self::InvalidAmount => f.write_str("invalid amount_cents"),
            Self::AmountOverflow => f.write_str("amount_cents overflow"),
        }
    }
}

impl std::error::Error for AnomalyError {}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ExpenseAnalyticsInput {
    pub id: String,
    pub entity: String,
    pub category: String,
    pub amount_cents: i64,
    #[serde(default)]
    pub occurred_on: Option<String>,
    #[serde(default)]
    pub doc_ref: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct AnalyzeExpensesRequest {
    #[serde(default)]
    pub threshold_cents: Option<i64>,
    pub expenses: Vec<ExpenseAnalyticsInput>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FiscalRedFlag {
    pub rule_code: &'static str,
    pub severity: &'static str,
    pub entity: String,
    pub category: Option<String>,
    pub total_cents: i64,
    pub expense_count: usize,
    pub affected_ids: Vec<String>,
    pub share_bps: Option<i64>,
    pub summary: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AnalyzeExpensesResponse {
    pub total_expenses: usize,
    pub total_amount_cents: i64,
    pub threshold_cents: i64,
    pub flag_count: usize,
    pub flags: Vec<FiscalRedFlag>,
}

type GroupAccumulator = (i128, Vec<String>);
type DuplicateKey = (String, String, i64, Option<String>);

pub fn analyze_expenses(
    req: &AnalyzeExpensesRequest,
) -> Result<AnalyzeExpensesResponse, AnomalyError> {
    let threshold_cents = req.threshold_cents.unwrap_or(DEFAULT_THRESHOLD_CENTS);
    if threshold_cents <= 0 {
        return Err(AnomalyError::InvalidThreshold);
    }

    let mut grand_total: i128 = 0;
    let mut splitting_groups: BTreeMap<(String, String), GroupAccumulator> = BTreeMap::new();
    let mut duplicate_groups: BTreeMap<DuplicateKey, GroupAccumulator> = BTreeMap::new();
    let mut entity_groups: BTreeMap<String, GroupAccumulator> = BTreeMap::new();

    for exp in &req.expenses {
        if exp.amount_cents < 0 {
            return Err(AnomalyError::InvalidAmount);
        }

        let amount_i128 = i128::from(exp.amount_cents);
        grand_total = grand_total
            .checked_add(amount_i128)
            .ok_or(AnomalyError::AmountOverflow)?;

        let entity = exp.entity.trim().to_string();
        let category = exp.category.trim().to_string();
        let occurred_on = exp
            .occurred_on
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string);

        let entity_entry = entity_groups
            .entry(entity.clone())
            .or_insert_with(|| (0, Vec::new()));
        entity_entry.0 = entity_entry
            .0
            .checked_add(amount_i128)
            .ok_or(AnomalyError::AmountOverflow)?;
        entity_entry.1.push(exp.id.clone());

        if exp.amount_cents > 0 {
            if exp.amount_cents < threshold_cents {
                let split_entry = splitting_groups
                    .entry((entity.clone(), category.clone()))
                    .or_insert_with(|| (0, Vec::new()));
                split_entry.0 = split_entry
                    .0
                    .checked_add(amount_i128)
                    .ok_or(AnomalyError::AmountOverflow)?;
                split_entry.1.push(exp.id.clone());
            }

            let dup_entry = duplicate_groups
                .entry((entity, category, exp.amount_cents, occurred_on))
                .or_insert_with(|| (0, Vec::new()));
            dup_entry.0 = dup_entry
                .0
                .checked_add(amount_i128)
                .ok_or(AnomalyError::AmountOverflow)?;
            dup_entry.1.push(exp.id.clone());
        }
    }

    let total_amount_cents =
        i64::try_from(grand_total).map_err(|_| AnomalyError::AmountOverflow)?;
    let threshold_i128 = i128::from(threshold_cents);

    let mut flags = Vec::new();

    for ((entity, category), (sum, ids)) in splitting_groups {
        if ids.len() >= 2 && sum >= threshold_i128 {
            let total_cents = i64::try_from(sum).map_err(|_| AnomalyError::AmountOverflow)?;
            flags.push(FiscalRedFlag {
                rule_code: "CONTRACT_SPLITTING",
                severity: "HIGH",
                entity,
                category: Some(category),
                total_cents,
                expense_count: ids.len(),
                affected_ids: ids,
                share_bps: None,
                summary: "Multiple below-threshold disbursements to the same entity and category exceed procurement threshold",
            });
        }
    }

    for ((entity, category, _, _), (sum, ids)) in duplicate_groups {
        if ids.len() >= 2 {
            let total_cents = i64::try_from(sum).map_err(|_| AnomalyError::AmountOverflow)?;
            flags.push(FiscalRedFlag {
                rule_code: "DUPLICATE_DISBURSEMENT",
                severity: "MEDIUM",
                entity,
                category: Some(category),
                total_cents,
                expense_count: ids.len(),
                affected_ids: ids,
                share_bps: None,
                summary: "Repeated disbursements with identical entity, category, amount, and date",
            });
        }
    }

    if grand_total > 0 && (entity_groups.len() >= 2 || req.expenses.len() >= 3) {
        for (entity, (entity_total, ids)) in entity_groups {
            if entity_total * 100 >= grand_total * CONCENTRATION_THRESHOLD_PCT {
                let share_bps_i128 = (entity_total * BPS_SCALE) / grand_total;
                let share_bps =
                    i64::try_from(share_bps_i128).map_err(|_| AnomalyError::AmountOverflow)?;
                let total_cents =
                    i64::try_from(entity_total).map_err(|_| AnomalyError::AmountOverflow)?;
                flags.push(FiscalRedFlag {
                    rule_code: "HIGH_ENTITY_CONCENTRATION",
                    severity: "MEDIUM",
                    entity,
                    category: None,
                    total_cents,
                    expense_count: ids.len(),
                    affected_ids: ids,
                    share_bps: Some(share_bps),
                    summary: "Single entity accounts for at least 70% of total analyzed spend",
                });
            }
        }
    }

    Ok(AnalyzeExpensesResponse {
        total_expenses: req.expenses.len(),
        total_amount_cents,
        threshold_cents,
        flag_count: flags.len(),
        flags,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        analyze_expenses, AnalyzeExpensesRequest, AnomalyError, ExpenseAnalyticsInput,
        DEFAULT_THRESHOLD_CENTS,
    };

    fn expense(
        id: &str,
        entity: &str,
        category: &str,
        amount_cents: i64,
        occurred_on: Option<&str>,
    ) -> ExpenseAnalyticsInput {
        ExpenseAnalyticsInput {
            id: id.to_string(),
            entity: entity.to_string(),
            category: category.to_string(),
            amount_cents,
            occurred_on: occurred_on.map(ToString::to_string),
            doc_ref: None,
        }
    }

    #[test]
    fn detects_contract_splitting_exact_integer() {
        let req = AnalyzeExpensesRequest {
            threshold_cents: None,
            expenses: vec![
                expense("e1", "Muni A", "OBRAS", 2_200_000, Some("2026-02-01")),
                expense("e2", "Muni A", "OBRAS", 2_100_000, Some("2026-02-05")),
                expense("e3", "Muni B", "SERVICIOS", 1_000_000, Some("2026-02-06")),
                expense("e4", "Muni C", "SALUD", 1_500_000, Some("2026-02-07")),
                expense("e5", "Muni D", "EDUCACION", 1_500_000, Some("2026-02-08")),
            ],
        };

        let res = analyze_expenses(&req).expect("should analyze");
        assert_eq!(res.threshold_cents, DEFAULT_THRESHOLD_CENTS);
        assert_eq!(res.total_expenses, 5);
        assert_eq!(res.total_amount_cents, 8_300_000);

        let split = res
            .flags
            .iter()
            .find(|f| f.rule_code == "CONTRACT_SPLITTING")
            .expect("should emit CONTRACT_SPLITTING");
        assert_eq!(split.severity, "HIGH");
        assert_eq!(split.entity, "Muni A");
        assert_eq!(split.category.as_deref(), Some("OBRAS"));
        assert_eq!(split.total_cents, 4_300_000);
        assert_eq!(split.expense_count, 2);
        assert_eq!(split.affected_ids, vec!["e1".to_string(), "e2".to_string()]);
    }

    #[test]
    fn detects_duplicate_disbursement() {
        let req = AnalyzeExpensesRequest {
            threshold_cents: Some(5_000_000),
            expenses: vec![
                expense("d1", "Muni A", "SERVICIOS", 150_000, Some("2026-02-10")),
                expense("d2", "Muni A", "SERVICIOS", 150_000, Some("2026-02-10")),
                expense("d3", "Muni B", "OBRAS", 500_000, Some("2026-02-11")),
            ],
        };

        let res = analyze_expenses(&req).expect("should analyze");
        let dup = res
            .flags
            .iter()
            .find(|f| f.rule_code == "DUPLICATE_DISBURSEMENT")
            .expect("should emit DUPLICATE_DISBURSEMENT");
        assert_eq!(dup.severity, "MEDIUM");
        assert_eq!(dup.entity, "Muni A");
        assert_eq!(dup.category.as_deref(), Some("SERVICIOS"));
        assert_eq!(dup.total_cents, 300_000);
        assert_eq!(dup.expense_count, 2);
        assert_eq!(dup.affected_ids, vec!["d1".to_string(), "d2".to_string()]);
    }

    #[test]
    fn detects_high_entity_concentration_with_exact_70_percent_boundary() {
        let req = AnalyzeExpensesRequest {
            threshold_cents: Some(10_000_000),
            expenses: vec![
                expense("c1", "Muni Alpha", "OBRAS", 700_000, Some("2026-02-01")),
                expense("c2", "Muni Beta", "OBRAS", 300_000, Some("2026-02-02")),
            ],
        };

        let res = analyze_expenses(&req).expect("should analyze");
        let conc = res
            .flags
            .iter()
            .find(|f| f.rule_code == "HIGH_ENTITY_CONCENTRATION")
            .expect("exact 70% should emit HIGH_ENTITY_CONCENTRATION");
        assert_eq!(conc.severity, "MEDIUM");
        assert_eq!(conc.entity, "Muni Alpha");
        assert_eq!(conc.share_bps, Some(7_000));
        assert_eq!(conc.total_cents, 700_000);

        let below_req = AnalyzeExpensesRequest {
            threshold_cents: Some(10_000_000),
            expenses: vec![
                expense("c1", "Muni Alpha", "OBRAS", 699_999, Some("2026-02-01")),
                expense("c2", "Muni Beta", "OBRAS", 300_001, Some("2026-02-02")),
            ],
        };
        let below_res = analyze_expenses(&below_req).expect("should analyze");
        assert!(
            !below_res
                .flags
                .iter()
                .any(|f| f.rule_code == "HIGH_ENTITY_CONCENTRATION"),
            "69.9999% must not trigger concentration"
        );
    }

    #[test]
    fn rejects_invalid_threshold_and_negative_amount() {
        let bad_threshold = AnalyzeExpensesRequest {
            threshold_cents: Some(0),
            expenses: vec![],
        };
        assert_eq!(
            analyze_expenses(&bad_threshold),
            Err(AnomalyError::InvalidThreshold)
        );

        let neg_amount = AnalyzeExpensesRequest {
            threshold_cents: None,
            expenses: vec![expense("x1", "Muni A", "OBRAS", -1, None)],
        };
        assert_eq!(
            analyze_expenses(&neg_amount),
            Err(AnomalyError::InvalidAmount)
        );
    }

    #[test]
    fn handles_empty_expenses_and_large_integer_concentration_without_overflow() {
        let empty_res = analyze_expenses(&AnalyzeExpensesRequest {
            threshold_cents: None,
            expenses: vec![],
        })
        .expect("empty expenses should succeed");
        assert_eq!(empty_res.total_expenses, 0);
        assert_eq!(empty_res.total_amount_cents, 0);
        assert_eq!(empty_res.flag_count, 0);

        let large = AnalyzeExpensesRequest {
            threshold_cents: None,
            expenses: vec![
                expense(
                    "big-1",
                    "Muni Mega",
                    "OBRAS",
                    3_000_000_000_000_000_000,
                    None,
                ),
                expense(
                    "big-2",
                    "Muni Small",
                    "OBRAS",
                    1_000_000_000_000_000_000,
                    None,
                ),
            ],
        };
        let large_res =
            analyze_expenses(&large).expect("i128 math should avoid intermediate overflow");
        assert_eq!(large_res.total_amount_cents, 4_000_000_000_000_000_000);
        let conc = large_res
            .flags
            .iter()
            .find(|f| f.rule_code == "HIGH_ENTITY_CONCENTRATION")
            .expect("75% should trigger");
        assert_eq!(conc.share_bps, Some(7_500));
    }
}
