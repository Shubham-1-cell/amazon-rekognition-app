const mysql = require('mysql');

const db = mysql.createConnection({
  host: 'localhost',
  user: 'your_db_user',
  password: 'your_db_password',
  database: 'ppe_detection_db'
});

db.connect((err) => {
  if (err) throw err;
  console.log('Database connected successfully');
});

module.exports = db;
