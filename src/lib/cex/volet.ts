import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import { sha256Hex } from "./crypto-utils.js";

const VOLET_API = "https://account.volet.com";
const VOLET_SOAP_URL = `${VOLET_API}/wsm/apiWebService`;

/**
 * Compute Volet auth token: SHA-256 hex of "securityWord:YYYYMMDD:HH".
 * Token rotates hourly.
 */
export async function voletAuthToken(securityWord: string, now?: Date): Promise<string> {
  const d = now ?? new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const prehash = `${securityWord}:${yyyy}${mm}${dd}:${hh}`;
  return sha256Hex(prehash);
}

/** Build a SOAP envelope and POST it to the Volet API. */
async function voletSoap(
  action: string,
  bodyXml: string,
  apiName: string,
  accountEmail: string,
  authToken: string,
  signal?: AbortSignal,
): Promise<Document> {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:wsm="http://api.volet.com/">
  <soapenv:Body>
    <wsm:${action}>
      <arg0>
        <apiName>${escapeXml(apiName)}</apiName>
        <authenticationToken>${escapeXml(authToken)}</authenticationToken>
        <accountEmail>${escapeXml(accountEmail)}</accountEmail>
      </arg0>
      ${bodyXml}
    </wsm:${action}>
  </soapenv:Body>
</soapenv:Envelope>`;

  const result = await cexFetch(
    VOLET_SOAP_URL,
    VOLET_API,
    "/api/volet",
    {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: `"${action}"`,
      },
      body: envelope,
    },
    signal,
  );

  const doc = new DOMParser().parseFromString(result.body, "text/xml");

  // Check for SOAP faults
  const fault = doc.getElementsByTagName("faultstring")[0];
  if (fault) {
    throw new Error(`Volet API error: ${fault.textContent ?? "Unknown SOAP fault"}`);
  }

  return doc;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Map Volet transactionName to CexLedgerRecord type. */
export function mapTransactionType(name: string): CexLedgerRecord["type"] {
  switch (name) {
    case "INNER_SYSTEM":
      return "transfer";
    case "CURRENCY_EXCHANGE":
      return "trade";
    case "WIRE_TRANSFER_DEPOSIT":
    case "CHECK_DEPOSIT":
    case "EXTERNAL_SYSTEM_DEPOSIT":
      return "deposit";
    case "WIRE_TRANSFER_WITHDRAW":
    case "BANK_CARD_TRANSFER":
    case "ADVCASH_CARD_TRANSFER":
    case "EXTERNAL_SYSTEM_WITHDRAWAL":
      return "withdrawal";
    default:
      return "other";
  }
}

/** Extract text content of a child element by tag name. */
function getText(parent: Element, tag: string): string {
  const el = parent.getElementsByTagName(tag)[0];
  return el?.textContent ?? "";
}

export class VoletAdapter implements CexAdapter {
  readonly exchangeId = "volet" as const;
  readonly exchangeName = "Volet";
  readonly requiresPassphrase = true;

  normalizeAsset(raw: string): string {
    return raw.toUpperCase();
  }

  async fetchLedgerRecords(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
    passphrase?: string,
  ): Promise<CexLedgerRecord[]> {
    if (!passphrase) {
      throw new Error("Volet requires Account Email (passphrase)");
    }

    const records: CexLedgerRecord[] = [];
    const PAGE_SIZE = 100;
    let from = 0;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const authToken = await voletAuthToken(apiSecret);

      let bodyParams = `<arg1>
        <count>${PAGE_SIZE}</count>
        <from>${from}</from>
        <sortOrder>ASCENDING</sortOrder>`;

      if (since) {
        const d = new Date(since * 1000);
        const sinceStr = d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
        bodyParams += `\n        <startTimeFrom>${sinceStr}</startTimeFrom>`;
      }

      bodyParams += "\n      </arg1>";

      const doc = await voletSoap("history", bodyParams, apiKey, passphrase, authToken, signal);

      // Find transaction elements in response
      const returnElements = doc.getElementsByTagName("return");
      if (returnElements.length === 0) break;

      let pageCount = 0;
      for (let i = 0; i < returnElements.length; i++) {
        const tx = returnElements[i];
        const id = getText(tx, "id");
        if (!id) continue; // skip the wrapper count element

        pageCount++;
        const amount = getText(tx, "amount");
        const currency = getText(tx, "currency");
        const direction = getText(tx, "direction");
        const txName = getText(tx, "transactionName");
        const fee = getText(tx, "fullCommission");
        const timestamp = getText(tx, "startTime");
        const senderEmail = getText(tx, "senderEmail");
        const receiverEmail = getText(tx, "receiverEmail");
        const comment = getText(tx, "comment");
        const orderId = getText(tx, "orderId");

        const isOutgoing = direction === "OUTGOING";
        const signedAmount = isOutgoing ? `-${amount}` : amount;

        // Parse timestamp — Volet returns xs:dateTime (ISO 8601)
        let ts: number;
        if (timestamp) {
          ts = new Date(timestamp).getTime() / 1000;
        } else {
          ts = Date.now() / 1000;
        }
        if (isNaN(ts)) {
          ts = Date.now() / 1000;
        }

        const metadata: Record<string, string> = {};
        if (senderEmail) metadata["sender_email"] = senderEmail;
        if (receiverEmail) metadata["receiver_email"] = receiverEmail;
        if (comment) metadata["comment"] = comment;
        if (txName) metadata["transaction_name"] = txName;
        if (orderId) metadata["order_id"] = orderId;

        records.push({
          refid: id,
          type: mapTransactionType(txName),
          asset: this.normalizeAsset(currency),
          amount: signedAmount,
          fee: fee || "0",
          timestamp: ts,
          txid: null,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });
      }

      if (pageCount < PAGE_SIZE) break;

      from += PAGE_SIZE;
      await abortableDelay(200, signal);
    }

    return records;
  }
}
