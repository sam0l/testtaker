const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises;
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const path = require('path');
const app = express();
const port = 3000;

app.use(fileUpload());
app.use(express.static('public'));

// Add CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Ensure uploads directory exists
const uploadsDir = './uploads';
fs.mkdir(uploadsDir, { recursive: true })
  .then(() => console.log('Uploads directory ensured:', uploadsDir))
  .catch(err => console.error('Error ensuring uploads directory:', err));

// Load or initialize question bank
let questions = [];
const questionFile = 'questions.json';

async function loadQuestions() {
  try {
    const data = await fs.readFile(questionFile, 'utf8');
    questions = JSON.parse(data);
    console.log('Loaded questions from', questionFile, ':', questions.length, 'questions');
  } catch (error) {
    console.error('Error loading questions:', error.message);
    questions = [];
  }
}

async function saveQuestions() {
  try {
    await fs.writeFile(questionFile, JSON.stringify(questions, null, 2));
    console.log('Saved questions to', questionFile, ':', questions.length, 'questions');
  } catch (error) {
    console.error('Error saving questions:', error.message);
  }
}

// --- Improved Parsing Logic ---

function parseLinesToQuestions(lines) {
  const questionRegex = /^(\d+)\)/;
  const optionRegex = /^[a-d]\)/i;
  const answerSectionRegex = /MOCK BOARD EXAM ANSWERS/i;

  let inAnswerSection = false;
  let answers = {};
  let newQuestions = [];
  let i = 0;

  while (i < lines.length) {
    let line = lines[i];

    if (answerSectionRegex.test(line)) {
      inAnswerSection = true;
      i++;
      continue;
    }

    if (inAnswerSection) {
      // Example: "12. A"
      if (line.match(/^\d+\.\s+[A-D]/i)) {
        const [qNum, ans] = line.split('. ');
        const answerText = ans.slice(2).trim();
        answers[qNum.replace('.', '')] = answerText;
        // console.log('Found answer:', qNum, answerText);
      }
      i++;
      continue;
    }

    // Parse question block
    let questionMatch = line.match(questionRegex);
    if (questionMatch) {
      let questionNumber = questionMatch[1];
      let questionLines = [line.replace(questionRegex, '').trim()];
      i++;

      // Accumulate question lines until we hit an option or next question or answer section
      while (
        i < lines.length &&
        !optionRegex.test(lines[i]) &&
        !questionRegex.test(lines[i]) &&
        !answerSectionRegex.test(lines[i])
      ) {
        questionLines.push(lines[i].trim());
        i++;
      }

      // Parse options
      let options = [];
      while (
        i < lines.length &&
        optionRegex.test(lines[i]) &&
        options.length < 4
      ) {
        let optionText = lines[i].replace(optionRegex, '').trim();
        i++;
        // Accumulate option lines
        while (
          i < lines.length &&
          !optionRegex.test(lines[i]) &&
          !questionRegex.test(lines[i]) &&
          !answerSectionRegex.test(lines[i])
        ) {
          optionText += ' ' + lines[i].trim();
          i++;
        }
        options.push(optionText);
      }

      newQuestions.push({
        questionNumber,
        question: questionLines.join(' '),
        options,
        answer: ''
      });
      continue;
    }

    i++;
  }

  // Offset logic to align answers with questions
  const firstAnswerKey = Math.min(...Object.keys(answers).map(Number));
  const firstQuestionNumber = Math.min(...newQuestions.map(q => Number(q.questionNumber)));
  const offset = firstAnswerKey - firstQuestionNumber;
  newQuestions.forEach(q => {
    q.questionNumber = (Number(q.questionNumber) + offset).toString();
  });

  newQuestions.forEach(q => {
    if (answers[q.questionNumber]) {
      q.answer = answers[q.questionNumber];
      // console.log('Assigned answer to question', q.questionNumber, ':', q.answer);
    }
  });

  const validQuestions = newQuestions.filter(q => q.options.length === 4 && q.answer);
  console.log('Parsed', validQuestions.length, 'valid questions');
  return validQuestions;
}

// --- PDF Parsing ---

async function parsePDF(filePath) {
  try {
    console.log('Starting to parse PDF:', filePath);
    const dataBuffer = await fs.readFile(filePath);
    const data = await pdfParse(dataBuffer);
    const text = data.text;
    console.log('PDF text extracted, total characters:', text.length);

    const lines = text.split('\n').map(line => line.trim()).filter(line => line);
    console.log('Total lines extracted:', lines.length);

    return parseLinesToQuestions(lines);
  } catch (error) {
    console.error('Error parsing PDF:', error.message);
    throw error;
  }
}

// --- Plain Text Parsing ---

async function parseText(content) {
  console.log('Parsing text content, length:', content.length);
  const lines = content.split('\n').map(line => line.trim()).filter(line => line);
  return parseLinesToQuestions(lines);
}

// --- DOCX Parsing ---

async function parseDocx(filePath) {
  console.log('Parsing DOCX file:', filePath);
  const result = await mammoth.extractRawText({ path: filePath });
  return parseText(result.value);
}

// --- Endpoints ---

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Log all incoming requests
app.use((req, res, next) => {
  console.log(`Received ${req.method} request at ${req.path} from ${req.ip}`);
  next();
});

// API to get questions
app.get('/api/questions', async (req, res) => {
  await loadQuestions();
  res.json(questions);
});

// API to upload and parse files
app.post('/api/upload', async (req, res) => {
  if (!req.files || !req.files.file) {
    console.log('No file uploaded');
    return res.status(400).json({ message: 'No file uploaded' });
  }

  const file = req.files.file;
  const filePath = path.join(uploadsDir, file.name);
  console.log('Received file:', file.name, 'Saving to:', filePath);

  try {
    await file.mv(filePath);
    console.log('File moved to:', filePath);

    let newQuestions = [];
    if (file.mimetype === 'application/pdf') {
      newQuestions = await parsePDF(filePath);
    } else if (file.mimetype === 'text/plain') {
      const content = await fs.readFile(filePath, 'utf8');
      newQuestions = await parseText(content);
    } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      newQuestions = await parseDocx(filePath);
    } else {
      console.log('Unsupported file type:', file.mimetype);
      return res.status(400).json({ message: 'Unsupported file type' });
    }

    questions = questions.concat(newQuestions);
    await saveQuestions();
    await fs.unlink(filePath);
    console.log('Upload complete, total questions:', questions.length);
    res.json({ message: 'File parsed and questions added', questionsAdded: newQuestions.length });
  } catch (error) {
    console.error('Error processing upload:', error.message);
    try {
      await fs.unlink(filePath).catch(() => {});
    } catch (cleanupError) {
      console.error('Error cleaning up file:', cleanupError.message);
    }
    res.status(500).json({ message: 'Error processing file: ' + error.message });
  }
});

app.listen(port, '0.0.0.0', async () => {
  console.log(`Server running at http://0.0.0.0:${port}`);
  await loadQuestions();
});
