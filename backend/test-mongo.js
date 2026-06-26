const mongoose = require('mongoose');
const uri = 'mongodb+srv://cut-crew:cutcrew2026@cutcrew.tp1ylbs.mongodb.net/?appName=CutCrew';

async function test(family) {
  console.log(`Testing family: ${family || 'default'}`);
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, family });
    console.log(`Success with family ${family || 'default'}!`);
    await mongoose.disconnect();
  } catch (e) {
    console.log(`Failed with family ${family || 'default'}: ${e.message}`);
  }
}

async function run() {
  await test(undefined);
  await test(4);
  await test(6);
  process.exit(0);
}
run();
