//! Dates as the page writes them, as en-GB writes them: "7 Oct", and times as 24-hour HH:MM.

use wings_plugin::{
    format::{clock, parse_time},
    host,
    local_time::local,
};

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// "7 Oct" from an ISO date, read as a calendar day in UTC.
pub fn day(iso: Option<&str>) -> String {
    let Some(ms) = iso.and_then(parse_time) else { return "?".to_owned() };
    // Days since 1970 to a civil date (Hinnant's algorithm).
    let z = (ms / 86_400_000.0).floor() as i64 + 719_468;
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (d, m) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    format!("{d} {}", MONTHS[(m - 1) as usize])
}

/// The time of day on this Mac, as 09:41.
pub fn time(iso: &str) -> String {
    parse_time(iso).map_or_else(String::new, clock)
}

/// "5m ago", "3h ago", "2d ago", or the date.
pub fn ago(iso: &str) -> String {
    let Some(at) = parse_time(iso) else { return String::new() };
    let m = ((host::now() - at) / 60_000.0).round();
    if m < 60.0 {
        format!("{}m ago", m.max(1.0))
    } else if m < 60.0 * 24.0 {
        format!("{}h ago", (m / 60.0).round())
    } else if m < 60.0 * 24.0 * 7.0 {
        format!("{}d ago", (m / 1440.0).round())
    } else {
        let at = local(at as i64);
        format!("{} {} {}", at.day, MONTHS[(at.month - 1) as usize], at.year)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_are_written_as_en_gb_writes_them_and_ages_as_the_page_always_has() {
        assert_eq!((day(Some("2026-10-05T00:00:00Z")), day(Some("2026-02-28T23:59:00Z")), day(None), day(Some("x"))), ("5 Oct".to_owned(), "28 Feb".to_owned(), "?".to_owned(), "?".to_owned()));
        let now = parse_time("2026-11-13T12:00:00Z").unwrap();
        host::testing::set_now(now);
        let ago_of = |minutes: f64| ago(&wings_plugin::format::iso_of(now - minutes * 60_000.0));
        assert_eq!([ago_of(0.0), ago_of(5.0), ago_of(180.0), ago_of(3.0 * 1440.0)], ["1m ago", "5m ago", "3h ago", "3d ago"]);
        assert_eq!(ago_of(10.0 * 1440.0), "3 Nov 2026");
        assert_eq!((ago("nope"), time("2026-11-13T09:41:00Z")), (String::new(), "09:41".to_owned()));
    }
}
