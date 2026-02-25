export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string;
}

export interface PdfTextLine {
  y: number;
  items: PdfTextItem[];
}

export interface PdfPage {
  pageNumber: number;
  lines: PdfTextLine[];
}

export interface PdfTransaction {
  date: string;
  description: string;
  amount: number;
  index: number;
}

export interface PdfStatement {
  accountNumber: string | null;
  iban: string | null;
  currency: string;
  openingBalance: number | null;
  openingDate: string | null;
  closingBalance: number | null;
  closingDate: string | null;
  transactions: PdfTransaction[];
  warnings: string[];
}
