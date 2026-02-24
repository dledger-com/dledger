/**
 * Read a File as text, with automatic fallback to Windows-1252 encoding
 * if UTF-8 produces replacement characters (U+FFFD).
 *
 * This handles ISO-8859-1 / Windows-1252 encoded CSVs (e.g. La Banque Postale)
 * that contain accented characters like é which become U+FFFD under UTF-8.
 */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const text = reader.result as string;
      // If UTF-8 produced replacement characters, retry as Windows-1252
      // (superset of ISO-8859-1, covers most Western European CSVs)
      if (text.includes('\uFFFD')) {
        const reader2 = new FileReader();
        reader2.onerror = () => reject(reader2.error);
        reader2.onload = () => resolve(reader2.result as string);
        reader2.readAsText(file, 'windows-1252');
      } else {
        resolve(text);
      }
    };
    reader.readAsText(file); // UTF-8 default
  });
}
