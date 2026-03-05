import { describe, it, expect } from "vitest";
import { CoinbaseAdapter, coinbaseSign, coinbaseHmacSign, isCdpKey, buildV2AuthHeaders } from "./coinbase.js";

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

/**
 * Extract the inner SEC1 DER bytes from a PKCS8 DER buffer.
 * PKCS8 layout: SEQUENCE { version, algId, OCTET STRING { sec1 } }
 * We skip outer SEQUENCE tag+len, version (3 bytes), algId (21 bytes),
 * then read the OCTET STRING tag+length to get the SEC1 payload.
 */
function extractSec1FromPkcs8(pkcs8: ArrayBuffer): Uint8Array {
  const bytes = new Uint8Array(pkcs8);
  let offset = 0;
  // Skip outer SEQUENCE tag (0x30)
  offset += 1;
  // Skip outer SEQUENCE length
  if (bytes[offset] & 0x80) {
    offset += 1 + (bytes[offset] & 0x7f);
  } else {
    offset += 1;
  }
  // Skip version: INTEGER 0 → 02 01 00
  offset += 3;
  // Skip AlgorithmIdentifier: 30 13 ... (21 bytes total)
  offset += 21;
  // Now at OCTET STRING tag (0x04)
  if (bytes[offset] !== 0x04) throw new Error("Expected OCTET STRING tag");
  offset += 1;
  // Read OCTET STRING length
  let sec1Len: number;
  if (bytes[offset] & 0x80) {
    const numLenBytes = bytes[offset] & 0x7f;
    offset += 1;
    sec1Len = 0;
    for (let i = 0; i < numLenBytes; i++) {
      sec1Len = (sec1Len << 8) | bytes[offset + i];
    }
    offset += numLenBytes;
  } else {
    sec1Len = bytes[offset];
    offset += 1;
  }
  return bytes.slice(offset, offset + sec1Len);
}

function wrapAsSec1Pem(sec1Der: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...sec1Der));
  const lines = base64.match(/.{1,64}/g)!;
  return `-----BEGIN EC PRIVATE KEY-----\n${lines.join("\n")}\n-----END EC PRIVATE KEY-----`;
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

  describe("isCdpKey", () => {
    it("detects CDP keys (organizations/ prefix)", () => {
      expect(isCdpKey("organizations/abc-123/apiKeys/key-456")).toBe(true);
      expect(isCdpKey("organizations/test-org/apiKeys/test-key")).toBe(true);
    });

    it("detects legacy keys (no organizations/ prefix)", () => {
      expect(isCdpKey("aB3dEfGhIjKlMnOp")).toBe(false);
      expect(isCdpKey("my-api-key-string")).toBe(false);
      expect(isCdpKey("")).toBe(false);
    });
  });

  describe("buildV2AuthHeaders", () => {
    it("CDP key → returns JWT Bearer header", async () => {
      await pemReady;

      const headers = await buildV2AuthHeaders(
        "organizations/test-org/apiKeys/test-key",
        testPemKey,
        "GET",
        "/v2/accounts",
      );

      expect(Object.keys(headers)).toEqual(["Authorization"]);
      expect(headers["Authorization"]).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    });

    it("legacy key → returns HMAC CB-ACCESS-* headers", async () => {
      const headers = await buildV2AuthHeaders(
        "legacy-api-key",
        "legacy-secret",
        "GET",
        "/v2/accounts",
      );

      expect(headers).toHaveProperty("CB-ACCESS-KEY", "legacy-api-key");
      expect(headers).toHaveProperty("CB-ACCESS-SIGN");
      expect(headers).toHaveProperty("CB-ACCESS-TIMESTAMP");
      expect(headers).toHaveProperty("CB-VERSION", "2023-01-01");
      expect(headers["CB-ACCESS-SIGN"]).toMatch(/^[0-9a-f]{64}$/);
      expect(headers).not.toHaveProperty("Authorization");
    });
  });

  describe("PEM with literal backslash-n sequences", () => {
    it("coinbaseSign succeeds when PEM has literal \\n instead of real newlines", async () => {
      await pemReady;

      // Simulate what Coinbase dashboard / JSON responses give: a single-line
      // PEM where newlines are represented as the two-character sequence \n.
      const singleLinePem = testPemKey.replace(/\n/g, "\\n");
      expect(singleLinePem).not.toContain("\n"); // no real newlines
      expect(singleLinePem).toContain("\\n"); // has literal \n

      const jwt = await coinbaseSign(
        "organizations/test-org/apiKeys/test-key",
        singleLinePem,
        "GET",
        "/api/v3/brokerage/orders/historical/fills",
      );

      const parts = jwt.split(".");
      expect(parts).toHaveLength(3);
    });
  });

  describe("parsePemPrivateKey error handling", () => {
    it("throws a clear error when secret is not valid base64/PEM", async () => {
      await expect(
        coinbaseSign(
          "organizations/test-org/apiKeys/test-key",
          "this-is-not-a-pem-key!!!",
          "GET",
          "/api/v3/brokerage/orders/historical/fills",
        ),
      ).rejects.toThrow(/Failed to decode PEM private key/);
    });
  });

  describe("importEcPrivateKey error handling", () => {
    it("throws a descriptive error for invalid key data", async () => {
      // Valid base64 but not a real PKCS8 key — importKey will reject
      const fakePem =
        "-----BEGIN PRIVATE KEY-----\n" +
        btoa("this is not a real key but is valid base64") +
        "\n-----END PRIVATE KEY-----";

      await expect(
        coinbaseSign(
          "organizations/test-org/apiKeys/test-key",
          fakePem,
          "GET",
          "/api/v3/brokerage/orders/historical/fills",
        ),
      ).rejects.toThrow(/Failed to import EC private key/);
    });
  });

  describe("SEC1 PEM support", () => {
    it("coinbaseSign succeeds with a SEC1 PEM key", async () => {
      await pemReady;

      // Generate a fresh key, export PKCS8, extract SEC1, wrap as SEC1 PEM
      const keyPair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      );
      const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
      const sec1Der = extractSec1FromPkcs8(pkcs8);
      const sec1Pem = wrapAsSec1Pem(sec1Der);

      expect(sec1Pem).toContain("-----BEGIN EC PRIVATE KEY-----");

      const jwt = await coinbaseSign(
        "organizations/test-org/apiKeys/test-key",
        sec1Pem,
        "GET",
        "/api/v3/brokerage/orders/historical/fills",
      );

      const parts = jwt.split(".");
      expect(parts).toHaveLength(3);
      for (const part of parts) {
        expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    });

    it("SEC1 PEM with literal backslash-n escapes works", async () => {
      await pemReady;

      const keyPair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      );
      const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
      const sec1Der = extractSec1FromPkcs8(pkcs8);
      const sec1Pem = wrapAsSec1Pem(sec1Der);

      // Replace real newlines with literal \n sequences
      const escapedPem = sec1Pem.replace(/\n/g, "\\n");
      expect(escapedPem).not.toContain("\n");
      expect(escapedPem).toContain("\\n");

      const jwt = await coinbaseSign(
        "organizations/test-org/apiKeys/test-key",
        escapedPem,
        "GET",
        "/api/v3/brokerage/orders/historical/fills",
      );

      const parts = jwt.split(".");
      expect(parts).toHaveLength(3);
    });
  });
});
