const mysql = require('mysql');

const db = mysql.createConnection({
  host: 'localhost',
  user: 'ppeadmin',
  password: 'ppeadmin2024',
  database: 'ppe_detection_db'
});

db.connect((err) => {
  if (err) throw err;
  console.log('Database connected successfully');
});

module.exports = db;
