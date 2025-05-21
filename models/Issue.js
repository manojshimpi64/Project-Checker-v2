const mongoose = require("mongoose");

const issueSchema = new mongoose.Schema({
  projectId: String,
  filePath: String,
  fileName: String,
  type: String,
  message: String,
  lineNumber: Number,
  status: {
    type: String,
    enum: ["new", "solved", "ignored"],
    default: "new",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("project_checker_log", issueSchema);
