import { describe, it, expect } from "vitest";
import { parseOfxDate, sgmlToXml, parseOfx } from "./parse-ofx.js";

describe("parseOfxDate", () => {
  it("parses standard YYYYMMDD", () => {
    expect(parseOfxDate("20230415")).toBe("2023-04-15");
  });

  it("parses date with time", () => {
    expect(parseOfxDate("20230415120000")).toBe("2023-04-15");
  });

  it("parses date with timezone offset", () => {
    expect(parseOfxDate("20230415120000[-5:EST]")).toBe("2023-04-15");
  });

  it("parses date with milliseconds", () => {
    expect(parseOfxDate("20230415120000.000")).toBe("2023-04-15");
  });

  it("parses date with millis and timezone", () => {
    expect(parseOfxDate("20230415120000.000[-5:EST]")).toBe("2023-04-15");
  });

  it("returns null for invalid date", () => {
    expect(parseOfxDate("")).toBeNull();
    expect(parseOfxDate("abcdefgh")).toBeNull();
    expect(parseOfxDate("2023")).toBeNull();
  });

  it("returns null for out-of-range month/day", () => {
    expect(parseOfxDate("20231301")).toBeNull(); // month 13
    expect(parseOfxDate("20230132")).toBeNull(); // day 32
    expect(parseOfxDate("20230000")).toBeNull(); // month 0
  });
});

describe("sgmlToXml", () => {
  it("closes unclosed leaf tags", () => {
    const sgml = "<TRNAMT>-100.50\n<NAME>Grocery Store\n";
    const xml = sgmlToXml(sgml);
    expect(xml).toContain("<TRNAMT>-100.50</TRNAMT>");
    expect(xml).toContain("<NAME>Grocery Store</NAME>");
  });

  it("preserves already-closed tags", () => {
    const sgml = "<STMTTRN><TRNAMT>50</TRNAMT></STMTTRN>\n";
    const xml = sgmlToXml(sgml);
    expect(xml).toContain("<TRNAMT>50</TRNAMT>");
    expect(xml).toContain("<STMTTRN>");
    expect(xml).toContain("</STMTTRN>");
  });

  it("handles whitespace in values", () => {
    const sgml = "<NAME>  Some Store  \n";
    const xml = sgmlToXml(sgml);
    expect(xml).toContain("<NAME>  Some Store</NAME>");
  });

  it("closes leaf tags in single-line SGML (no newlines)", () => {
    const sgml = "<TRNTYPE>PAYMENT<DTPOSTED>20260216<TRNAMT>-24.99<FITID>20260216001<NAME>Some Store";
    const xml = sgmlToXml(sgml);
    expect(xml).toContain("<TRNTYPE>PAYMENT</TRNTYPE>");
    expect(xml).toContain("<DTPOSTED>20260216</DTPOSTED>");
    expect(xml).toContain("<TRNAMT>-24.99</TRNAMT>");
    expect(xml).toContain("<FITID>20260216001</FITID>");
    expect(xml).toContain("<NAME>Some Store</NAME>");
  });

  it("does not break container tags", () => {
    const sgml = "<BANKACCTFROM>\n<BANKID>123456\n<ACCTID>9999\n</BANKACCTFROM>\n";
    const xml = sgmlToXml(sgml);
    expect(xml).toContain("<BANKID>123456</BANKID>");
    expect(xml).toContain("<ACCTID>9999</ACCTID>");
    expect(xml).toContain("<BANKACCTFROM>");
    expect(xml).toContain("</BANKACCTFROM>");
  });
});

describe("parseOfx", () => {
  it("parses SGML v1 bank statement", () => {
    const ofx = `
OFXHEADER:100
DATA:OFXSGML
VERSION:102
<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
<DTSERVER>20230415
<LANGUAGE>ENG
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<CURDEF>USD
<BANKACCTFROM>
<BANKID>123456789
<ACCTID>987654321
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20230401
<DTEND>20230415
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20230401
<TRNAMT>-50.00
<FITID>202304010001
<NAME>Grocery Store
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20230405
<TRNAMT>2500.00
<FITID>202304050001
<NAME>Payroll
<MEMO>Monthly salary
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>5430.25
<DTASOF>20230415
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

    const result = parseOfx(ofx);
    expect(result.statements).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);

    const stmt = result.statements[0];
    expect(stmt.currency).toBe("USD");
    expect(stmt.account.bankId).toBe("123456789");
    expect(stmt.account.acctId).toBe("987654321");
    expect(stmt.account.acctType).toBe("CHECKING");
    expect(stmt.account.accountType).toBe("bank");
    expect(stmt.transactions).toHaveLength(2);

    const tx1 = stmt.transactions[0];
    expect(tx1.trnType).toBe("DEBIT");
    expect(tx1.dtPosted).toBe("20230401");
    expect(tx1.trnAmt).toBe("-50.00");
    expect(tx1.fitId).toBe("202304010001");
    expect(tx1.name).toBe("Grocery Store");

    const tx2 = stmt.transactions[1];
    expect(tx2.trnType).toBe("CREDIT");
    expect(tx2.trnAmt).toBe("2500.00");
    expect(tx2.name).toBe("Payroll");
    expect(tx2.memo).toBe("Monthly salary");

    expect(stmt.ledgerBalance).toBeDefined();
    expect(stmt.ledgerBalance!.balAmt).toBe("5430.25");
    expect(stmt.ledgerBalance!.dtAsOf).toBe("20230415");
  });

  it("parses XML v2 credit card statement", () => {
    const ofx = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="220"?>
<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS></SONRS></SIGNONMSGSRSV1>
<CREDITCARDMSGSRSV1>
<CCSTMTTRNRS>
<CCSTMTRS>
<CURDEF>EUR</CURDEF>
<CCACCTFROM>
<ACCTID>4111222233334444</ACCTID>
</CCACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT</TRNTYPE>
<DTPOSTED>20230310</DTPOSTED>
<TRNAMT>-25.50</TRNAMT>
<FITID>CC20230310001</FITID>
<NAME>Restaurant</NAME>
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>-1250.75</BALAMT>
<DTASOF>20230315</DTASOF>
</LEDGERBAL>
</CCSTMTRS>
</CCSTMTTRNRS>
</CREDITCARDMSGSRSV1>
</OFX>`;

    const result = parseOfx(ofx);
    expect(result.statements).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);

    const stmt = result.statements[0];
    expect(stmt.currency).toBe("EUR");
    expect(stmt.account.accountType).toBe("creditcard");
    expect(stmt.account.acctId).toBe("4111222233334444");
    expect(stmt.transactions).toHaveLength(1);
    expect(stmt.transactions[0].trnAmt).toBe("-25.50");
    expect(stmt.ledgerBalance!.balAmt).toBe("-1250.75");
  });

  it("parses both bank and credit card in one file", () => {
    const ofx = `<?xml version="1.0"?>
<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>USD</CURDEF>
<BANKACCTFROM><BANKID>111</BANKID><ACCTID>222</ACCTID><ACCTTYPE>SAVINGS</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20230101</DTPOSTED><TRNAMT>100</TRNAMT><FITID>B1</FITID><NAME>Deposit</NAME></STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
<CURDEF>USD</CURDEF>
<CCACCTFROM><ACCTID>3333</ACCTID></CCACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20230102</DTPOSTED><TRNAMT>-50</TRNAMT><FITID>C1</FITID><NAME>Store</NAME></STMTTRN>
</BANKTRANLIST>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>
</OFX>`;

    const result = parseOfx(ofx);
    expect(result.statements).toHaveLength(2);
    expect(result.statements[0].account.accountType).toBe("bank");
    expect(result.statements[0].account.acctType).toBe("SAVINGS");
    expect(result.statements[1].account.accountType).toBe("creditcard");
  });

  it("extracts LEDGERBAL correctly", () => {
    const ofx = `<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>USD
<BANKACCTFROM><BANKID>111</BANKID><ACCTID>222</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20230101</DTPOSTED><TRNAMT>-10</TRNAMT><FITID>X1</FITID><NAME>Test</NAME></STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>1234.56
<DTASOF>20230115
</LEDGERBAL>
<AVAILBAL>
<BALAMT>1200.00
<DTASOF>20230115
</AVAILBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

    const result = parseOfx(ofx);
    const stmt = result.statements[0];
    expect(stmt.ledgerBalance).toBeDefined();
    expect(stmt.ledgerBalance!.balAmt).toBe("1234.56");
    expect(stmt.availableBalance).toBeDefined();
    expect(stmt.availableBalance!.balAmt).toBe("1200.00");
  });

  it("handles missing optional fields gracefully", () => {
    const ofx = `<?xml version="1.0"?>
<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>GBP</CURDEF>
<BANKACCTFROM><BANKID>999</BANKID><ACCTID>888</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT</TRNTYPE>
<DTPOSTED>20230501</DTPOSTED>
<TRNAMT>-15.00</TRNAMT>
<FITID>F1</FITID>
</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

    const result = parseOfx(ofx);
    expect(result.statements).toHaveLength(1);
    const tx = result.statements[0].transactions[0];
    expect(tx.name).toBeUndefined();
    expect(tx.memo).toBeUndefined();
    expect(tx.checkNum).toBeUndefined();
    expect(result.statements[0].ledgerBalance).toBeUndefined();
  });

  it("handles empty transaction list", () => {
    const ofx = `<?xml version="1.0"?>
<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>USD</CURDEF>
<BANKACCTFROM><BANKID>111</BANKID><ACCTID>222</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST></BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

    const result = parseOfx(ofx);
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0].transactions).toHaveLength(0);
  });

  it("warns on malformed transactions", () => {
    const ofx = `<?xml version="1.0"?>
<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>USD</CURDEF>
<BANKACCTFROM><BANKID>111</BANKID><ACCTID>222</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT</TRNTYPE>
<DTPOSTED>20230101</DTPOSTED>
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT</TRNTYPE>
<DTPOSTED>20230102</DTPOSTED>
<TRNAMT>100</TRNAMT>
<FITID>OK1</FITID>
<NAME>Valid</NAME>
</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

    const result = parseOfx(ofx);
    expect(result.statements[0].transactions).toHaveLength(1);
    expect(result.statements[0].transactions[0].fitId).toBe("OK1");
    expect(result.warnings).toContain("Skipped malformed transaction (missing required fields)");
  });

  it("ignores QFX INTU.* tags", () => {
    const ofx = `
OFXHEADER:100
DATA:OFXSGML
VERSION:102
<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
<DTSERVER>20230415
<LANGUAGE>ENG
<INTU.BID>12345
<INTU.USERID>user@example.com
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<CURDEF>USD
<BANKACCTFROM>
<BANKID>123
<ACCTID>456
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20230401
<TRNAMT>-25.00
<FITID>QFX001
<NAME>Coffee Shop
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

    const result = parseOfx(ofx);
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0].transactions).toHaveLength(1);
    expect(result.statements[0].transactions[0].fitId).toBe("QFX001");
  });

  it("returns warning when no <OFX> tag found", () => {
    const result = parseOfx("This is not an OFX file");
    expect(result.statements).toHaveLength(0);
    expect(result.warnings).toContain("No <OFX> tag found in file");
  });

  it("returns warning when no statements found", () => {
    const ofx = `<?xml version="1.0"?>
<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE></STATUS></SONRS></SIGNONMSGSRSV1>
</OFX>`;

    const result = parseOfx(ofx);
    expect(result.statements).toHaveLength(0);
    expect(result.warnings).toContain("No statement data found in OFX file");
  });

  it("parses CHECKNUM field", () => {
    const ofx = `<?xml version="1.0"?>
<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>USD</CURDEF>
<BANKACCTFROM><BANKID>111</BANKID><ACCTID>222</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>CHECK</TRNTYPE>
<DTPOSTED>20230101</DTPOSTED>
<TRNAMT>-200.00</TRNAMT>
<FITID>CHK001</FITID>
<CHECKNUM>1234</CHECKNUM>
<NAME>Check payment</NAME>
</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

    const result = parseOfx(ofx);
    expect(result.statements[0].transactions[0].checkNum).toBe("1234");
  });

  it("parses single-line SGML bank statement", () => {
    // Modeled on La Banque Postale exports where the entire SGML body is on a single line
    const txLines = Array.from({ length: 19 }, (_, i) => {
      const day = String(i + 1).padStart(2, "0");
      const amt = (-(10 + i * 2.5)).toFixed(2);
      return `<STMTTRN><TRNTYPE>PAYMENT<DTPOSTED>202602${day}<TRNAMT>${amt}<FITID>2026${day}${String(i).padStart(3, "0")}<NAME>Tx ${i + 1}</STMTTRN>`;
    }).join("");

    const ofx =
      `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n` +
      `<OFX>` +
      `<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20260220<LANGUAGE>FRA</SONRS></SIGNONMSGSRSV1>` +
      `<BANKMSGSRSV1><STMTTRNRS><STMTRS>` +
      `<CURDEF>EUR` +
      `<BANKACCTFROM><BANKID>20041<ACCTID>1234567X020<ACCTTYPE>CHECKING</BANKACCTFROM>` +
      `<BANKTRANLIST><DTSTART>20260201<DTEND>20260220` +
      txLines +
      `</BANKTRANLIST>` +
      `<LEDGERBAL><BALAMT>707.39<DTASOF>20260220</LEDGERBAL>` +
      `</STMTRS></STMTTRNRS></BANKMSGSRSV1>` +
      `</OFX>`;

    const result = parseOfx(ofx);
    expect(result.warnings).toHaveLength(0);
    expect(result.statements).toHaveLength(1);

    const stmt = result.statements[0];
    expect(stmt.currency).toBe("EUR");
    expect(stmt.account.bankId).toBe("20041");
    expect(stmt.account.acctId).toBe("1234567X020");
    expect(stmt.account.acctType).toBe("CHECKING");
    expect(stmt.transactions).toHaveLength(19);

    // Spot-check first and last
    expect(stmt.transactions[0].trnType).toBe("PAYMENT");
    expect(stmt.transactions[0].trnAmt).toBe("-10.00");
    expect(stmt.transactions[0].name).toBe("Tx 1");
    expect(stmt.transactions[18].trnAmt).toBe("-55.00");
    expect(stmt.transactions[18].name).toBe("Tx 19");

    expect(stmt.ledgerBalance).toBeDefined();
    expect(stmt.ledgerBalance!.balAmt).toBe("707.39");
  });
});
