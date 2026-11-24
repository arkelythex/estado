use csv::ReaderBuilder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum IngestError {
    #[error("invalid csv format")]
    Csv(#[from] csv::Error),
    #[error("empty csv input")]
    EmptyCsv,
    #[error("invalid csv header")]
    InvalidHeader,
    #[error("invalid csv row")]
    InvalidRow,
    #[error("invalid date format")]
    InvalidDate,
    #[error("invalid monetary amount: {reason}")]
    InvalidAmount { reason: &'static str },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExpenseRowCents {
    pub entity: String,
    pub category: String,
    pub amount_cents: i64,
    pub occurred_on: Option<String>,
    pub doc_ref: Option<String>,
}

pub type CsvExpenseRow = ExpenseRowCents;

pub fn checksum_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex::encode(digest)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    checksum_sha256(bytes)
}

pub fn parse_amount_cents(raw: &str) -> Result<i64, IngestError> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(IngestError::InvalidAmount {
            reason: "amount cannot be empty",
        });
    }
    if s.starts_with('-') {
        return Err(IngestError::InvalidAmount {
            reason: "negative amount is not allowed",
        });
    }
    if s.starts_with('+') {
        return Err(IngestError::InvalidAmount {
            reason: "leading '+' sign is not allowed",
        });
    }

    let (whole_str, frac_opt) = match s.split_once('.') {
        Some((whole, frac)) => {
            if frac.contains('.') {
                return Err(IngestError::InvalidAmount {
                    reason: "multiple decimal points",
                });
            }
            (whole, Some(frac))
        }
        None => (s, None),
    };

    if whole_str.is_empty() || !whole_str.bytes().all(|b| b.is_ascii_digit()) {
        return Err(IngestError::InvalidAmount {
            reason: "invalid integer digits",
        });
    }

    let whole = whole_str
        .parse::<i64>()
        .map_err(|_| IngestError::InvalidAmount {
            reason: "amount overflows i64",
        })?;

    let frac_cents: i64 = match frac_opt {
        None => 0,
        Some(frac) => {
            if frac.is_empty() {
                return Err(IngestError::InvalidAmount {
                    reason: "trailing decimal point without digits",
                });
            }
            if frac.len() > 2 {
                return Err(IngestError::InvalidAmount {
                    reason: "more than 2 decimal places",
                });
            }
            if !frac.bytes().all(|b| b.is_ascii_digit()) {
                return Err(IngestError::InvalidAmount {
                    reason: "invalid fractional digits",
                });
            }
            let parsed = frac
                .parse::<i64>()
                .map_err(|_| IngestError::InvalidAmount {
                    reason: "invalid fractional digits",
                })?;
            if frac.len() == 1 {
                parsed * 10
            } else {
                parsed
            }
        }
    };

    whole
        .checked_mul(100)
        .and_then(|w| w.checked_add(frac_cents))
        .ok_or(IngestError::InvalidAmount {
            reason: "amount cents overflows i64",
        })
}

#[derive(Debug, Deserialize)]
struct RawCsvExpenseRow {
    entity: String,
    category: String,
    amount: String,
    #[serde(default)]
    occurred_on: Option<String>,
    #[serde(default)]
    doc_ref: Option<String>,
}

pub fn parse_expense_csv(content: &str) -> Result<Vec<CsvExpenseRow>, IngestError> {
    parse_expenses_csv_cents(content)
}

pub fn parse_expenses_csv_cents(content: &str) -> Result<Vec<ExpenseRowCents>, IngestError> {
    if content.trim().is_empty() {
        return Err(IngestError::EmptyCsv);
    }

    let mut reader = ReaderBuilder::new()
        .trim(csv::Trim::All)
        .from_reader(content.as_bytes());

    let headers = reader.headers()?.clone();
    let has_entity = headers.iter().any(|h| h == "entity");
    let has_category = headers.iter().any(|h| h == "category");
    let has_amount = headers.iter().any(|h| h == "amount");
    if !has_entity || !has_category || !has_amount {
        return Err(IngestError::InvalidHeader);
    }

    let mut rows = Vec::new();
    for record in reader.deserialize::<RawCsvExpenseRow>() {
        let raw = record?;
        let entity = raw.entity.trim().to_string();
        let category = raw.category.trim().to_string();
        if entity.is_empty() || category.is_empty() {
            return Err(IngestError::InvalidRow);
        }
        let amount_cents = parse_amount_cents(&raw.amount)?;
        let occurred_on = match raw
            .occurred_on
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
        {
            Some(date) => {
                validate_iso_date(&date)?;
                Some(date)
            }
            None => None,
        };
        let doc_ref = raw
            .doc_ref
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());

        rows.push(ExpenseRowCents {
            entity,
            category,
            amount_cents,
            occurred_on,
            doc_ref,
        });
    }

    Ok(rows)
}

fn validate_iso_date(value: &str) -> Result<(), IngestError> {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes[0..4].iter().all(u8::is_ascii_digit)
        || !bytes[5..7].iter().all(u8::is_ascii_digit)
        || !bytes[8..10].iter().all(u8::is_ascii_digit)
    {
        return Err(IngestError::InvalidDate);
    }
    let year: u32 = value[0..4].parse().map_err(|_| IngestError::InvalidDate)?;
    let month: u32 = value[5..7].parse().map_err(|_| IngestError::InvalidDate)?;
    let day: u32 = value[8..10].parse().map_err(|_| IngestError::InvalidDate)?;
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            let leap =
                (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400);
            if leap {
                29
            } else {
                28
            }
        }
        _ => return Err(IngestError::InvalidDate),
    };
    if year == 0 || day == 0 || day > max_day {
        return Err(IngestError::InvalidDate);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        checksum_sha256, parse_amount_cents, parse_expense_csv, parse_expenses_csv_cents,
        sha256_hex, ExpenseRowCents,
    };

    #[test]
    fn checksum_is_stable() {
        let checksum = checksum_sha256(b"demo");
        assert_eq!(checksum.len(), 64);
        assert_eq!(checksum, sha256_hex(b"demo"));
    }

    #[test]
    fn parses_demo_csv_into_exact_cents() {
        let csv = "entity,category,amount,occurred_on,doc_ref\nMunicipio Demo,OBRAS,1200.5,2026-01-01,DOC-1\n";
        let rows = parse_expense_csv(csv).expect("csv should parse");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].entity, "Municipio Demo");
        assert_eq!(rows[0].amount_cents, 120_050);
    }

    #[test]
    fn parses_exact_amount_cents() {
        assert_eq!(parse_amount_cents("1234.56").unwrap(), 123_456);
        assert_eq!(parse_amount_cents("100").unwrap(), 10_000);
        assert_eq!(parse_amount_cents("1200.5").unwrap(), 120_050);
        assert_eq!(parse_amount_cents("0").unwrap(), 0);
        assert_eq!(parse_amount_cents("0.05").unwrap(), 5);
        assert_eq!(parse_amount_cents(" 42.10 ").unwrap(), 4_210);
    }

    #[test]
    fn rejects_invalid_amounts_without_echoing_input() {
        let err = parse_amount_cents("pii-secret-123").unwrap_err();
        assert!(!err.to_string().contains("pii-secret-123"));

        for bad in [
            "",
            "   ",
            "-10.00",
            "-0.01",
            "-0",
            "+10.00",
            "12.345",
            "12.000",
            "12.",
            ".50",
            "12.34.56",
            "1,234.56",
            "abc",
            "9999999999999999999",
        ] {
            assert!(
                parse_amount_cents(bad).is_err(),
                "expected '{bad}' to be rejected"
            );
        }
    }

    #[test]
    fn parses_expenses_csv_into_exact_cents() {
        let csv = include_str!("../../../fixtures/demo_expenses.csv");
        let rows = parse_expenses_csv_cents(csv).expect("fixture csv should parse");
        assert_eq!(
            rows,
            vec![
                ExpenseRowCents {
                    entity: "Municipio Demo".to_string(),
                    category: "OBRAS".to_string(),
                    amount_cents: 125_075,
                    occurred_on: Some("2026-02-01".to_string()),
                    doc_ref: Some("DOC-001".to_string()),
                },
                ExpenseRowCents {
                    entity: "Municipio Demo".to_string(),
                    category: "SERVICIOS".to_string(),
                    amount_cents: 32_050,
                    occurred_on: Some("2026-02-02".to_string()),
                    doc_ref: Some("DOC-002".to_string()),
                },
                ExpenseRowCents {
                    entity: "Municipio Demo".to_string(),
                    category: "PERSONAL".to_string(),
                    amount_cents: 210_000,
                    occurred_on: Some("2026-02-03".to_string()),
                    doc_ref: Some("DOC-003".to_string()),
                },
            ]
        );
    }

    #[test]
    fn rejects_invalid_csv_inputs() {
        assert!(parse_expenses_csv_cents("").is_err());
        assert!(parse_expenses_csv_cents("   \n").is_err());
        assert!(parse_expenses_csv_cents("foo,bar\n1,2\n").is_err());
        assert!(parse_expenses_csv_cents("entity,category,amount\n,OBRAS,10.00\n").is_err());
        assert!(parse_expenses_csv_cents("entity,category,amount\nMuni,,10.00\n").is_err());
        assert!(parse_expenses_csv_cents("entity,category,amount\nMuni,OBRAS,-5.00\n").is_err());
        assert!(parse_expenses_csv_cents("entity,category,amount\nMuni,OBRAS,5.123\n").is_err());
        assert!(parse_expenses_csv_cents(
            "entity,category,amount,occurred_on\nMuni,OBRAS,5.00,2026-13-01\n"
        )
        .is_err());
        assert!(parse_expenses_csv_cents(
            "entity,category,amount,occurred_on\nMuni,OBRAS,5.00,not-a-date\n"
        )
        .is_err());
        assert!(parse_expenses_csv_cents(
            "entity,category,amount,occurred_on\nMuni,OBRAS,5.00,2026-02-30\n"
        )
        .is_err());
        assert!(parse_expenses_csv_cents(
            "entity,category,amount,occurred_on\nMuni,OBRAS,5.00,2026-+1-01\n"
        )
        .is_err());
        assert!(parse_expenses_csv_cents(
            "entity,category,amount,occurred_on\nMuni,OBRAS,5.00,+001-01-01\n"
        )
        .is_err());
    }
}
