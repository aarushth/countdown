import Database from "better-sqlite3";
import * as path from "path";

export interface ScheduleEntry {
  id?: number;
  name: string;
  startTime: Date;
  endTime: Date;
}

class ScheduleDatabase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const defaultPath = path.join(__dirname, "../schedule.db");
    this.db = new Database(dbPath || defaultPath);
    this.init();
  }

  /**
   * Initialize the database and create tables if they don't exist
   */
  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedule (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        startTime TEXT NOT NULL,
        endTime TEXT NOT NULL
      )
    `);
    console.log("Database initialized");
  }

  /**
   * Insert a schedule entry
   */
  insert(entry: Omit<ScheduleEntry, "id">): number {
    const stmt = this.db.prepare(`
      INSERT INTO schedule (name, startTime, endTime)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(
      entry.name,
      entry.startTime.toISOString(),
      entry.endTime.toISOString(),
    );
    return result.lastInsertRowid as number;
  }

  /**
   * Insert multiple schedule entries
   */
  insertMany(entries: Omit<ScheduleEntry, "id">[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO schedule (name, startTime, endTime)
      VALUES (?, ?, ?)
    `);

    const insertMany = this.db.transaction(
      (items: Omit<ScheduleEntry, "id">[]) => {
        for (const item of items) {
          stmt.run(
            item.name,
            item.startTime.toISOString(),
            item.endTime.toISOString(),
          );
        }
      },
    );

    insertMany(entries);
  }

  /**
   * Get all schedule entries
   */
  getAll(): ScheduleEntry[] {
    const stmt = this.db.prepare("SELECT * FROM schedule");
    const rows = stmt.all() as any[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      startTime: new Date(row.startTime),
      endTime: new Date(row.endTime),
    }));
  }

  /**
   * Get a schedule entry by ID
   */
  getById(id: number): ScheduleEntry | undefined {
    const stmt = this.db.prepare("SELECT * FROM schedule WHERE id = ?");
    const row = stmt.get(id) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      startTime: new Date(row.startTime),
      endTime: new Date(row.endTime),
    };
  }

  /**
   * Clear all entries from the schedule table
   */
  clearAll(): void {
    this.db.exec("DELETE FROM schedule");
    console.log("All schedule entries cleared");
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}

export default ScheduleDatabase;
