import Database from 'better-sqlite3';
const db = new Database('C:/Users/Mini/Desktop/API-HUB/server/data/freeapi.db');
const rows = db.prepare("SELECT COALESCE(a.status, 'unknown') as s, count(*) as c FROM models m LEFT JOIN model_availability a ON a.model_db_id = m.id GROUP BY s").all();
console.log(rows);
const total = db.prepare('select count(*) as c from models m LEFT JOIN model_availability a ON a.model_db_id = m.id').get();
console.log('total', total.c);
