const express = require("express");
const fs = require("fs-extra");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const bodyParser = require("body-parser");
const connectDB = require("./config/db");

const { ignoreDirectories, globalProjectVariables } = require("./config");

const generateExcel = require("./utils/exportExcel");
const generatePdf = require("./utils/exportPdf");
const Issue = require("./models/Issue");

const app = express();

connectDB(); // Connect to MongoDB

// Middleware setup
app.set("view engine", "ejs");
app.use(express.static("public"));

app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.post("/export/pdf", (req, res) => {
  const warnings = JSON.parse(req.body.data || "[]");
  generatePdf(warnings, res);
});

app.post("/export/excel", async (req, res) => {
  const warnings = JSON.parse(req.body.data || "[]");
  await generateExcel(warnings, res);
});

// Forsorting Route

// Routes
app.get("/reset", (req, res) => {
  res.render("index", {
    message: null,
    warnings: [],
    warningCount: 0,
    directoryPath: "",
    pageName: "",
    projectName: "",
    checkType: "",
    checkOption: "",
  });
});

app.post("/issue/:id/solve", async (req, res) => {
  const issueId = req.params.id;

  await Issue.findByIdAndUpdate(issueId, { status: "solved" });

  const sortedWarnings = await fetchAllIssues();

  res.render("index", {
    message: "✅ Issue marked as solved.",
    warnings: sortedWarnings,
    classSuccess: "alert-success",
    warningCount: sortedWarnings.length,
    // Retain previous form values
    directoryPath: req.body.directoryPath || "",
    projectName: req.body.projectName || "",
    pageName: req.body.pageName || "",
    checkType: req.body.checkType || "",
    checkOption: req.body.checkOption || "",
  });
});

app.post("/issue/:id/ignore", async (req, res) => {
  const issueId = req.params.id;
  const sortedWarnings = await fetchAllIssues();
  await Issue.findByIdAndUpdate(issueId, { status: "ignored" });
  res.render("index", {
    message: "✅ Issue marked as ignored.",
    warnings: sortedWarnings,
    classSuccess: "alert-success",
    warningCount: sortedWarnings.length,
    // Retain previous form values
    directoryPath: req.body.directoryPath || "",
    projectName: req.body.projectName || "",
    pageName: req.body.pageName || "",
    checkType: req.body.checkType || "",
    checkOption: req.body.checkOption || "",
  });
});

app.post("/check", async (req, res) => {
  const { directoryPath, pageName, checkType, checkOption, projectName } =
    req.body;
  //console.log(req.body);
  const warnings = [];

  const directoryExists = await fs.pathExists(directoryPath);
  if (!directoryExists) {
    return res.render("index", {
      message: "Invalid directory path. Please try again.",
      warnings: [],
      warningCount: 0,
      directoryPath,
      pageName,
      checkType,
      projectName,
      checkOption,
    });
  }

  try {
    const allFiles = await getReactFiles(directoryPath);

    if (checkType === "project") {
      for (let file of allFiles) {
        await checkFile(file, directoryPath, warnings, checkOption);
      }
    } else {
      const pageFiles = pageName.split(",").map((name) => name.trim());

      for (let page of pageFiles) {
        const matchedFiles = allFiles.filter((file) => file.endsWith(page));

        if (matchedFiles.length === 0) {
          warnings.push({
            filePath: directoryPath,
            fileName: page,
            type: "⚠️ File not found",
            message: `The file '${page}' was not found in any subdirectory.`,
          });
          continue;
        }

        for (let filePath of matchedFiles) {
          await checkFile(filePath, directoryPath, warnings, checkOption);
        }
      }
    }

    // Insert the warnings into the MongoDB database after collecting them
    if (warnings.length > 0) {
      const warningsWithProject = warnings.map((warning) => ({
        ...warning,
        projectId: projectName,
      }));

      await insertWarnings(warningsWithProject);
    }

    const sortedWarnings = await fetchAllIssues(); // Call the fetch function

    const hasWarnings = warnings.length > 0;
    res.render("index", {
      message: hasWarnings ? null : "✅ No issues found!",
      warnings: sortedWarnings,
      warningCount: sortedWarnings.length,
      directoryPath,
      projectName,
      pageName,
      checkType,
      checkOption,
    });
  } catch (error) {
    console.error("Error during check:", error.message);
    res.render("index", {
      message: "An error occurred. Please try again.",
      warnings: [],
      warningCount: 0,
      directoryPath,
      projectName,
      pageName,
      checkType,
      checkOption,
    });
  }
});

// Helper: Recursively fetch valid files
async function getReactFiles(dir) {
  let files = [];
  const items = await fs.readdir(dir);

  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = await fs.stat(fullPath);

    // Skip ignored folders
    if (stat.isDirectory()) {
      if (!ignoreDirectories.includes(item)) {
        files.push(...(await getReactFiles(fullPath)));
      }
    } else if (/\.(js|jsx|html|php)$/.test(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

// File check based on selected check option
async function checkFile(filePath, basePath, warnings, checkOption) {
  const exists = await fs.pathExists(filePath);
  const fileName = path.basename(filePath);

  if (!exists) {
    warnings.push({
      filePath: basePath,
      fileName,
      type: "⚠️ File not found",
      message: `The file '${fileName}' does not exist.`,
    });
    return;
  }

  const content = await fs.readFile(filePath, "utf-8");
  const $ = cheerio.load(content);

  switch (checkOption) {
    case "showAll":
      checkForMissingAltAttributes($, warnings, filePath, fileName, content);
      //await checkForBrokenLinks($, warnings, filePath, fileName, content);
      //checkForMissingFooter($, warnings, filePath, fileName, content);
      checkForHtmlComments($, warnings, filePath, fileName, content);

      checkForGlobalProjectVariablesMissing(
        $,
        warnings,
        filePath,
        fileName,
        content
      );
      break;
    case "missingAltTags":
      checkForMissingAltAttributes($, warnings, filePath, fileName, content);
      break;
    case "brokenLinks":
      await checkForBrokenLinks($, warnings, filePath, fileName, content);
      break;
    case "missingFooter":
      checkForMissingFooter($, warnings, filePath, fileName, content);
      break;
    case "htmlComments":
      checkForHtmlComments($, warnings, filePath, fileName, content);
      break;
    case "GlobalProjectVariablesMissing":
      checkForGlobalProjectVariablesMissing(
        $,
        warnings,
        filePath,
        fileName,
        content
      );
      break;
  }
}

// ===== Check Functions =====
function checkForMissingAltAttributes(
  $,
  warnings,
  filePath,
  fileName,
  content
) {
  const lines = content.split("\n");
  $("img").each((_, el) => {
    const alt = $(el).attr("alt");
    const src = $(el).attr("src") || "[no src]";

    let lineNumber = -1;
    let shouldIgnore = false;

    for (let i = 0; i < lines.length; i++) {
      if (src !== "[no src]" && lines[i].includes(src)) {
        lineNumber = i + 1;

        if (lines[i].includes("#evIgnore")) {
          shouldIgnore = true;
        }
        break;
      }
    }

    if (shouldIgnore) return; // ⬅️ Only skips this image

    if (!alt || alt.trim() === "") {
      warnings.push({
        filePath,
        fileName,
        //type: "⚠️ Missing alt",
        type: "Missing Alt",
        message: `Image with src '${src}' is missing alt text.`,
        lineNumber: lineNumber !== -1 ? lineNumber : null,
      });
    }
  });
}

// by sunil
// function checkForMissingAltAttributes(
//   $,
//   warnings,
//   filePath,
//   fileName,
//   content
// ) {
//   const lines = content.split("\n");

//   $("img").each((_, el) => {
//     const alt = $(el).attr("alt");
//     const src = $(el).attr("src") || "[no src]";
//     const html = $.html(el);

//     // Find which line this <img> tag appears on
//     for (let i = 0; i < lines.length; i++) {
//       if (lines[i].includes(html)) {
//         const lineContent = lines[i];

//         // Skip if line contains "#evIgnore"
//         if (lineContent.includes("#evIgnore")) {
//           return;
//         }

//         if (!alt || alt.trim() === "") {
//           warnings.push({
//             filePath,
//             fileName,
//             type: "⚠️ Missing alt",
//             message: `Image with src '${src}' is missing alt text.`,
//             lineNumber: i + 1,
//           });
//         }

//         break; // Found the line, no need to continue
//       }
//     }
//   });
// }

async function checkForBrokenLinks($, warnings, filePath, fileName, content) {
  const links = $("a")
    .map((_, el) => $(el).attr("href"))
    .get()
    .filter((href) => href && href.startsWith("http"));

  const promises = links.map((link) =>
    axios.get(link).catch(() => {
      warnings.push({
        filePath,
        fileName,
        type: "⚠️ Broken link",
        message: `Broken link: ${link}`,
        lineNumber: findLineNumber(link, content),
      });
    })
  );

  await Promise.all(promises);
}

function checkForHtmlComments($, warnings, filePath, fileName, content) {
  const commentRegex = /<!--([\s\S]*?)-->/g;
  let match;

  while ((match = commentRegex.exec(content)) !== null) {
    const fullMatch = match[0]; // Full comment string: <!-- ... -->
    const commentText = match[1].trim(); // Inner text
    const lineNumber = findLineNumber(fullMatch, content);

    // Skip empty comments
    if (!commentText) continue;

    // Determine if it's single-line or multi-line
    const isMultiline = fullMatch.includes("\n");
    /* const type = isMultiline
      ? "📄 Multi-line HTML comment"
      : "💬 Single-line HTML comment";*/
    const type = isMultiline
      ? "Multi Line HTML Comment"
      : "Single Line HTML Comment";

    warnings.push({
      filePath,
      fileName,
      type,
      message: `Found HTML comment: "${commentText.slice(0, 80)}${
        commentText.length > 80 ? "..." : ""
      }"`,
      lineNumber,
    });
  }
}

function checkForMissingFooter($, warnings, filePath, fileName, content) {
  if ($("footer").length === 0) {
    warnings.push({
      filePath,
      fileName,
      //type: "⚠️ Missing footer",
      type: "Missing Footer",
      message: `Missing <footer> tag.`,
      lineNumber: findLineNumber("<footer>", content),
    });
  }
}

// function checkForGlobalProjectVariablesMissing(
//   $,
//   warnings,
//   filePath,
//   fileName,
//   content
// ) {
//   const globals = globalProjectVariables;
//   globals.forEach((varName) => {
//     if (content.includes(varName)) {
//       warnings.push({
//         filePath,
//         fileName,
//         type: "⚠️ Global variable usage",
//         message: `Global variable '${varName}' found. Consider modular approach.`,
//         lineNumber: findLineNumber(varName, content),
//       });
//     }
//   });
// }

function checkForGlobalProjectVariablesMissing(
  _,
  warnings,
  filePath,
  fileName,
  content
) {
  const globals = globalProjectVariables;
  const lines = content.split("\n");

  globals.forEach((varName) => {
    const regex = new RegExp(varName, "g"); // Match all occurrences
    let match;

    while ((match = regex.exec(content)) !== null) {
      const matchIndex = match.index;

      // Find the line number and content
      let charCount = 0;
      let lineNumber = 0;
      for (let i = 0; i < lines.length; i++) {
        charCount += lines[i].length + 1; // +1 for the newline char
        if (charCount > matchIndex) {
          lineNumber = i + 1;
          break;
        }
      }

      const lineContent = lines[lineNumber - 1];

      // Skip if the line contains "#evIgnore"
      if (lineContent.includes("#evIgnore")) continue;

      warnings.push({
        filePath,
        fileName,
        //type: "⚠️ Global variable usage",
        type: "Global Variable Usage",
        message: `Global variable '${varName}' found. Consider modular approach.`,
        lineNumber,
      });
    }
  });
}

/*
function checkForGlobalProjectVariablesMissing(
  _,
  warnings,
  filePath,
  fileName,
  content
) {
  const globals = globalProjectVariables;

  globals.forEach((varName) => {
    const regex = new RegExp(varName, "g"); // Match all occurrences
    let match;
    while ((match = regex.exec(content)) !== null) {
      const lineNumber = findLineNumber(varName, content, match.index);

      warnings.push({
        filePath,
        fileName,
        type: "⚠️ Global variable usage",
        message: `Global variable '${varName}' found. Consider modular approach.`,
        lineNumber,
      });
    }
  });
} */

// Utility: Line number locator
function findLineNumber(searchString, content) {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(searchString)) return i + 1;
  }
  return -1;
}

/*function findLineNumber(searchString, content, fromIndex = 0) {
  const lines = content.slice(0, fromIndex).split("\n");
  return lines.length;
}*/

// Insert Error

async function insertWarnings(warnings) {
  try {
    let insertedCount = 0;

    for (let warning of warnings) {
      const exists = await Issue.findOne({
        type: warning.type,
        lineNumber: warning.lineNumber,
        fileName: warning.fileName,
        filePath: warning.filePath,
      });

      if (!exists) {
        await Issue.create(warning);
        insertedCount++;
      }
    }

    console.log(`${insertedCount} unique warnings inserted into the database.`);
  } catch (err) {
    console.error("❌ Error inserting warnings:", err);
  }
}

async function fetchAllIssues(projectName = "") {
  try {
    let query = { status: "new" };
    if (projectName) {
      query.projectId = projectName;
    }

    const issues = await Issue.find(query).sort({ createdAt: -1 }); // Sorting by createdAt or use any other field
    return issues;
  } catch (error) {
    console.error("❌ Error in fetchAllIssues:", error);
    throw error;
  }
}

/*async function fetchAllIssues() {
  try {
    const issues = await Issue.find({ status: "new" }).sort({ createdAt: -1 }); // Sort by newest
    return issues;
  } catch (error) {
    console.error("❌ Error in fetchAllIssues:", error);
    throw error;
  }
}*/

// Render View

// Start server
app.listen(3000, () => {
  console.log("Server running at http://localhost:3000");
});
