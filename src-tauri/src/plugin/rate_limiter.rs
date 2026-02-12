use std::sync::Mutex;
use std::time::Instant;

/// Simple token bucket rate limiter.
pub struct RateLimiter {
    inner: Mutex<RateLimiterInner>,
}

struct RateLimiterInner {
    tokens: f64,
    max_tokens: f64,
    refill_rate: f64, // tokens per second
    last_refill: Instant,
}

impl RateLimiter {
    /// Create a new rate limiter.
    /// `max_per_minute`: maximum requests per minute.
    pub fn new(max_per_minute: u32) -> Self {
        let max_tokens = max_per_minute as f64;
        Self {
            inner: Mutex::new(RateLimiterInner {
                tokens: max_tokens,
                max_tokens,
                refill_rate: max_tokens / 60.0,
                last_refill: Instant::now(),
            }),
        }
    }

    /// Try to acquire a token. Returns true if allowed, false if rate-limited.
    pub fn try_acquire(&self) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let now = Instant::now();
        let elapsed = now.duration_since(inner.last_refill).as_secs_f64();
        inner.tokens = (inner.tokens + elapsed * inner.refill_rate).min(inner.max_tokens);
        inner.last_refill = now;

        if inner.tokens >= 1.0 {
            inner.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}
