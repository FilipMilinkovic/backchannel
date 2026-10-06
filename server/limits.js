// In-memory abuse limits for a single hub process: token buckets and per-user caps on open streams.
import { httpError } from './auth.js';

const MAX_KEYS = 50_000;

export class RateLimiter {
  constructor(perMinute) {
    this.capacity = perMinute;
    this.refillPerMs = perMinute / 60_000;
    this.buckets = new Map(); // key -> { tokens, at }
    setInterval(() => this.sweep(), 60_000).unref();
  }

  // Throws 429 when the key has no budget left; sets retryAfter (seconds) on the error.
  take(key, cost = 1) {
    const now = Date.now();
    // Bounded memory: under a flood of distinct keys, forget full buckets first, then everything.
    if (this.buckets.size >= MAX_KEYS && !this.buckets.has(key)) { this.sweep(); if (this.buckets.size >= MAX_KEYS) this.buckets.clear(); }
    const b = this.buckets.get(key) || { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.at) * this.refillPerMs);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens < cost) {
      const err = httpError(429, 'too many requests, slow down');
      err.retryAfter = Math.ceil((cost - b.tokens) / this.refillPerMs / 1000);
      throw err;
    }
    b.tokens -= cost;
  }

  sweep() {
    const now = Date.now();
    for (const [key, b] of this.buckets) if (b.tokens + (now - b.at) * this.refillPerMs >= this.capacity) this.buckets.delete(key);
  }
}

// Counts long-lived connections (SSE streams, long polls) per user. acquire() returns a release function.
export class StreamCap {
  constructor(max) { this.max = max; this.open = new Map(); }
  acquire(userId) {
    const n = this.open.get(userId) || 0;
    if (n >= this.max) throw httpError(429, `too many open connections (max ${this.max})`);
    this.open.set(userId, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.open.get(userId) || 1) - 1;
      if (left) this.open.set(userId, left); else this.open.delete(userId);
    };
  }
}
