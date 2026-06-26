const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

router.get('/', (req, res, next) => {
  try {
    const logFile = path.join(__dirname, '../../server.log');
    
    if (!fs.existsSync(logFile)) {
      return res.status(200).json({ status: 'success', data: [] });
    }

    // Read the file. For production with huge files, a stream or tail module is better.
    // For this simple implementation, we read it and slice the last 200 lines.
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim() !== '');
    
    const lastLines = lines.slice(-200);

    res.status(200).json({
      status: 'success',
      data: lastLines
    });
  } catch (error) {
    console.error('Error reading logs:', error);
    next(error);
  }
});

module.exports = router;
