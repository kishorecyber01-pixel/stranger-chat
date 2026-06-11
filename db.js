const mongoose = require("mongoose");

mongoose.connect(process.env.MONGO_URI);

mongoose.connection.on("connected", () => {
  console.log("✅ MongoDB Connected");
});

mongoose.connection.on("error", (err) => {
  console.log("❌ MongoDB Error:", err);
});

module.exports = mongoose;