// inspect_db.js
import sqlite3 from "sqlite3";
import { open } from "sqlite";
(async () => {
  const db = await open({ filename: './eden_lite.db', driver: sqlite3.Database });
  console.log("=== books sample (first 80 rows) ===");
  console.log(await db.all("SELECT book_id, code, name FROM books ORDER BY CAST(book_id AS INTEGER) LIMIT 120"));

  console.log("=== find book 'john' ===");
  console.log(await db.all("SELECT book_id, code, name FROM books WHERE LOWER(name) LIKE 'john%'"));
  console.log(await db.all("SELECT book_id, code, name FROM books WHERE LOWER(name) = 'john'"));
  console.log(await db.all("SELECT book_id FROM books WHERE code = 'john'"));

  console.log("=== chapters in verses (book_id=43) ===");
  console.log(await db.all("SELECT DISTINCT chapter FROM verses WHERE book_id = 43 ORDER BY chapter"));

  console.log("=== verses in verses (book_id=43 chapter=3) ===");
  console.log(await db.all("SELECT id, verse, COALESCE(text_plain, text, '') AS text FROM verses WHERE book_id = 43 AND chapter = 3 ORDER BY verse"));

  console.log("=== verses in verses_api (if exists) ===");
  try { console.log(await db.all("SELECT id, verse, COALESCE(text_plain, text, '') AS text FROM verses_api WHERE book_id = 43 AND chapter = 3 ORDER BY verse")); } catch(e){ console.log("verses_api error:", e.message); }

  console.log("=== verses in verses_with_book (if exists) ===");
  try { console.log(await db.all("SELECT id, verse, COALESCE(text_plain, text, '') AS text FROM verses_with_book WHERE book_id = 43 AND chapter = 3 ORDER BY verse")); } catch(e){ console.log("verses_with_book error:", e.message); }

  await db.close();
})();
