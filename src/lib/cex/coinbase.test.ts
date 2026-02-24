import { describe, it, expect } from "vitest";
import { CoinbaseAdapter, coinbaseSign, coinbaseHmacSign } from "./coinbase.js";

// A test-only PKCS8 PEM private key for EC P-256.
// Generated purely for unit testing — not a real credential.
// We generate it dynamically in beforeAll to avoid shipping a static key.
let testPemKey: string;

async function generateTestPem(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const exported = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
  // Format as PEM with 64-char line wrapping
  const lines = base64.match(/.{1,64}/g)!;
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}

describe("CoinbaseAdapter", () => {
  const adapter = new CoinbaseAdapter();

  // Generate a test key before all tests run
  let pemReady: Promise<void>;
  pemReady = generateTestPem().then((pem) => {
    testPemKey = pem;
  });

  describe("normalizeAsset", () => {
    it("returns standard codes unchanged", () => {
      expect(adapter.normalizeAsset("BTC")).toBe("BTC");
      expect(adapter.normalizeAsset("ETH")).toBe("ETH");
      expect(adapter.normalizeAsset("USD")).toBe("USD");
      expect(adapter.normalizeAsset("USDC")).toBe("USDC");
    });

    it("returns arbitrary codes as-is", () => {
      expect(adapter.normalizeAsset("SHIB")).toBe("SHIB");
      expect(adapter.normalizeAsset("DOGE")).toBe("DOGE");
    });
  });

  describe("coinbaseHmacSign", () => {
    it("produces a hex string", async () => {
      const sig = await coinbaseHmacSign(
        "test-secret",
        "1700000000",
        "GET",
        "/v2/accounts",
      );

      expect(sig).toBeTruthy();
      expect(typeof sig).toBe("string");
      // SHA-256 HMAC produces 64 hex characters
      expect(sig).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces different signatures for different timestamps", async () => {
      const sig1 = await coinbaseHmacSign(
        "test-secret",
        "1700000000",
        "GET",
        "/v2/accounts",
      );
      const sig2 = await coinbaseHmacSign(
        "test-secret",
        "1700000001",
        "GET",
        "/v2/accounts",
      );

      expect(sig1).not.toBe(sig2);
    });

    it("produces different signatures for different paths", async () => {
      const sig1 = await coinbaseHmacSign(
        "test-secret",
        "1700000000",
        "GET",
        "/v2/accounts",
      );
      const sig2 = await coinbaseHmacSign(
        "test-secret",
        "1700000000",
        "GET",
        "/v2/accounts/abc/transactions",
      );

      expect(sig1).not.toBe(sig2);
    });

    it("produces different signatures for different secrets", async () => {
      const sig1 = await coinbaseHmacSign(
        "secret-one",
        "1700000000",
        "GET",
        "/v2/accounts",
      );
      const sig2 = await coinbaseHmacSign(
        "secret-two",
        "1700000000",
        "GET",
        "/v2/accounts",
      );

      expect(sig1).not.toBe(sig2);
    });

    it("includes body in the prehash when provided", async () => {
      const sigNoBody = await coinbaseHmacSign(
        "test-secret",
        "1700000000",
        "POST",
        "/v2/some-endpoint",
      );
      const sigWithBody = await coinbaseHmacSign(
        "test-secret",
        "1700000000",
        "POST",
        "/v2/some-endpoint",
        '{"key":"value"}',
      );

      expect(sigNoBody).not.toBe(sigWithBody);
    });
  });

  describe("coinbaseSign (JWT)", () => {
    it("returns a valid JWT format (3 dot-separated base64url parts)", async () => {
      await pemReady;

      const jwt = await coinbaseSign(
        "organizations/test-org/apiKeys/test-key",
        testPemKey,
        "GET",
        "/api/v3/brokerage/orders/historical/fills",
      );

      expect(typeof jwt).toBe("string");
      const parts = jwt.split(".");
      expect(parts).toHaveLength(3);

      // Each part should be base64url encoded (alphanumeric, -, _, no padding)
      for (const part of parts) {
        expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    });

    it("JWT header contains correct fields", async () => {
      await pemReady;

      const jwt = await coinbaseSign(
        "organizations/test-org/apiKeys/test-key",
        testPemKey,
        "GET",
        "/api/v3/brokerage/orders/historical/fills",
      );

      const headerPart = jwt.split(".")[0];
      // Decode base64url to JSON
      const headerJson = atob(headerPart.replace(/-/g, "+").replace(/_/g, "/"));
      const header = JSON.parse(headerJson);

      expect(header.alg).toBe("ES256");
      expect(header.kid).toBe("organizations/test-org/apiKeys/test-key");
      expect(header.typ).toBe("JWT");
      expect(typeof header.nonce).toBe("string");
      expect(header.nonce).toMatch(/^[0-9a-f]{32}$/); // 16 bytes as hex
    });

    it("JWT payload contains correct claims", async () => {
      await pemReady;

      const apiKey = "organizations/test-org/apiKeys/test-key";
      const path = "/api/v3/brokerage/orders/historical/fills";

      const jwt = await coinbaseSign(apiKey, testPemKey, "GET", path);

      const payloadPart = jwt.split(".")[1];
      const payloadJson = atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/"));
      const payload = JSON.parse(payloadJson);

      expect(payload.sub).toBe(apiKey);
      expect(payload.iss).toBe("coinbase-cloud");
      expect(payload.aud).toEqual(["retail_rest_api_proxy"]);
      expect(payload.uri).toBe(`GET api.coinbase.com${path}`);
      expect(typeof payload.exp).toBe("number");
      expect(typeof payload.nbf).toBe("number");
      expect(payload.exp).toBe(payload.nbf + 120);
    });

    it("produces different JWTs for different paths", async () => {
      await pemReady;

      const jwt1 = await coinbaseSign(
        "organizations/test-org/apiKeys/test-key",
        testPemKey,
        "GET",
        "/api/v3/brokerage/orders/historical/fills",
      );
      const jwt2 = await coinbaseSign(
        "organizations/test-org/apiKeys/test-key",
        testPemKey,
        "GET",
        "/api/v3/brokerage/accounts",
      );

      // Payloads differ because URI differs
      expect(jwt1.split(".")[1]).not.toBe(jwt2.split(".")[1]);
    });
  });

  describe("exchangeId", () => {
    it("is coinbase", () => {
      expect(adapter.exchangeId).toBe("coinbase");
    });
  });

  describe("exchangeName", () => {
    it("is Coinbase", () => {
      expect(adapter.exchangeName).toBe("Coinbase");
    });
  });
});
