import { deflateSync } from "node:zlib";
export const amazonOrderId = "305-1234567-1234567";
export const amazonReceiptText = (
  number = "TEST-AMAZON-1",
  amount = "5.10",
  orderId = amazonOrderId,
  date = "02 October 2026",
) => `Invoice
Sold by Amazon EU S.a r.l.
Invoice date / Delivery date ${date}
Invoice number ${number}
Amount payable ${amount} EUR
Order number ${orderId}
Description Quantity Unit price VAT % Unit price Subtotal
Huggies diapers 1 ${amount} EUR 24% ${amount} EUR ${amount} EUR
ASIN: TEST-ASIN
Invoice total ${amount} EUR`;
// Synthetic examples exercise parser contracts; these are not retailer exports.
export const receiptText = (
  retailer = "Rimi",
  number = "1001",
  date = "02.10.2026",
) => `${retailer}
Receipt nr ${number}
${date}
Piim 2,00
Pesuvahend 3,00
Pant 0,10
Kokku 5,10
Pangakaart 5,10
KM 24% 0,99`;
// Synthetic Partnerkaart export: BOM, fractional quantities, repeated products,
// Partnerapp tender, a separate VAT total and receipt metadata in the footer.
export const selverCsv = `\uFEFFTest Selver
Selver AS
NIMETUS;TOOTEKOOD;KOGUS;HIND;SUMMA
\tKilekott Selver;TEST-1;1;0,39;0,39
\tAvokaado.;TEST-2;0.228;6,97;1,59
\tMahe raudne tatrap;TEST-3;1;1,95;1,95
\tMahe raudne tatrap;TEST-3;1;1,95;1,95
\tHambavahepuhasti;TEST-4;1;3,75;3,75
KOKKU;9,63

\tPARTNERAPP;9,63

KM%;NETO;KM;BRUTO
\t24%;7,77;1,86;9,63
KOKKU;7,77;1,86;9,63

PARTNERKAARDI NR;TEST-CARD

TŠEKK;KUUPÄEV;AEG;KASSA
CSV-1001;28.09.2026;12:00;TEST`;
export const woltOrderId = "abcdef0123456789abcdef01";
export const woltReceiptText = (
  delivery = false,
  orderId = woltOrderId,
) => `${delivery ? "Wolt delivery receipt" : "Receipt"} #TEST/${orderId}/${delivery ? "delivery" : "food"}
Order details
Order ID ${orderId}
${delivery ? "Order type Delivery" : "Venue Test Burger Kitchen"}
Delivery time 02.10.2026 12:00
Payment method
Apple Pay ${delivery ? "1.40" : "6.00"}
Item VAT % Quantity Gross unit price Price
${
  delivery
    ? `Delivery 24% 1 0.00 0.00
Tip for courier 0% 1 0.50 0.50
Service fee 0.90
Service fee 24% 1 1.00 1.00
Wolt+ service fee discount 24% 1 -0.10 -0.10`
    : `Burger with fries
4.00
Burger 24% 1 5.00 5.00
with fries
Discount 24% 1 -1.00 -1.00
Lemonade 24% 1 2.00 2.00`
}
Total in EUR (incl. VAT) ${delivery ? "1.40" : "6.00"}
Net price VAT Total
VAT 24% 4.84 1.16 6.00
Seller details: ${delivery ? "Wolt" : "Test Restaurant"}
Receipt delivered by Wolt.
This document is digitally signed.`;
export const lidlReceiptText = `Lidl Eesti OU
1007519 Suur poekott
0,29 x 1 tk. 0,29 A
1013636 Jaatis soola karam
0,89 x 1 tk. 0,89 A
Allahindlus: -0,24
Lopphind 9,65
0080000 Banaan
1,15 x 0,810 KG 0,93 A
- -0,29
Lopphind 9,64
5501459 EDAM juust
1,35 x | tk. 1,35 A
KM KM-ta KM-ga
A= 24% 0,57 2,37 2,93
Vahesumma 3,46
Allahindlus kokku -0,53
Tasuda 2,93
Makstud (pangakaart) 2,93
KAARDIMAKSE
SUMMA: 2,93 EUR
Tšeki nr. TEST-LIDL-1001
Kassiir: 90 02.10.2026 12:00:00`;
export const coopReceiptText = `Summa 5.67 EUR
Test Konsum
Test store address
Toode Kogus Kokku
AVOKAADO 2TK 1 2.79
HEAVENLY ANANASSI 0.33L 1 1.49
PANT C/0.10EUR 1 0.10
COCA-COLA ZERO 0.33L PRK 1 1.19
PANT C/0.10EUR 1 0.10
Kokku 5.67 EUR
KM % Summa km-ta KM Summa km-ga
Kaibemaks 24 % 4.41 EUR 1.06 EUR 5.47 EUR
Kaibemaks 0 % 0.20 EUR 0.00 EUR 0.20 EUR
Makseviis
Kaart 5.67 EUR
Tsekk nr COOP-TEST-1001
Kuupaev 03/10/2026 11:58:09
Kliendikaart TEST-CARD
Test Tarbijate Uhistu`;
export function textPdf(text: string): Buffer {
  const lines = text
    .split("\n")
    .map((line) =>
      line.replace(/[^\x20-\x7e]/g, "?").replace(/([\\()])/g, "\\$1"),
    );
  const stream = `BT /F1 13 Tf 30 790 Td 20 TL ${lines.map((line, i) => `${i ? "T* " : ""}(${line}) Tj`).join("\n")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let document = "%PDF-1.4\n",
    offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = Buffer.byteLength(document);
  document += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(document);
}

// An image-only PDF exercises PDF.js's intermediate canvas rendering as well
// as OCR. A text PDF or a directly uploaded PNG cannot catch that path.
export function scannedPdf(
  width: number,
  height: number,
  rgba: Uint8ClampedArray,
): Buffer {
  const rgb = Buffer.alloc(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel++)
    for (let channel = 0; channel < 3; channel++)
      rgb[pixel * 3 + channel] = rgba[pixel * 4 + channel];
  const image = deflateSync(rgb);
  const stream = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`;
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
    ),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`,
      ),
      image,
      Buffer.from("\nendstream"),
    ]),
    Buffer.from(
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ),
  ];
  let document = Buffer.from("%PDF-1.4\n");
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(document.length);
    document = Buffer.concat([
      document,
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
  });
  const start = document.length;
  return Buffer.concat([
    document,
    Buffer.from(
      `xref\n0 6\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`,
    ),
  ]);
}

// Synthetic Selver PDF layout, including a discounted row, repeated items,
// fractional quantity, deposits, and a bonus/payment split.
export const selverPdfText = `Test Selver
Kokku 9,83 EUR
Kassa TEST
Tšeki nr PDF-1001
Kuupäev 28.09.2026 12:00:00
Partnerkaart TEST
Toode Kogus Ühiku hind Kokku
Kilekott Selver 1 0,39 0,39 EUR
Avokaado. 0,228 6,97 1,59 EUR
Mahe raudne tatrap 1 1,95 1,95 EUR
Mahe raudne tatrap 1 1,95 1,95 EUR
Hambavahepuhasti 1 4,45 3,75 EUR
--- Kampaania võit 0,70 EUR ---
Metallpakend C 1 0,10 0,10 EUR
Metallpakend C 1 0,10 0,10 EUR
Sinu võit kokku: 0,70 EUR
Kokku 9,83 EUR
Makseviis
Boonusmakse 0,47 EUR
PartnerÄpp makse 9,36 EUR
KOKKU 9,83 EUR
Selver AS`;
