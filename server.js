import express from "express";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const app = express();
const port = process.env.PORT || 3000;

// open the database
const dbPromise = open({
  filename: "./eden_lite.db",
  driver: sqlite3.Database
});

// example endpoint: /verse?book=John&chapter=3&verse=16
app.get("/verse", async (req, res) => {
  const { book, chapter, verse } = req.query;
  const db = await dbPromise;

  const row = await db.get(
    "SELECT text FROM bible_kjv WHERE book = ? AND chapter = ? AND verse = ?",
    [book, chapter, verse]
  );

  res.json(row || { error: "Verse not found" });
});

app.listen(port, () => console.log(`Eden Bible API running on port ${port}`));
