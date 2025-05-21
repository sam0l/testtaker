const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises;
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const path = require('path');
const app = express();
const port = 3000;

app.use(fileUpload());
app.use(express.json()); // Added to parse JSON bodies
app.use(express.static('public'));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const uploadsDir = './uploads';
fs.mkdir(uploadsDir, { recursive: true })
  .then(() => console.log('Uploads directory ensured:', uploadsDir))
  .catch(err => console.error('Error ensuring uploads directory:', err));

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

function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function cleanOCRText(text) {
  const corrections = {
    'Açri': 'April',
    'Jaw': 'Jan',
    'Lending': 'Bending',
    'Â': '',
    'â': '',
    'ç': 'c'
  };
  let cleaned = text;
  for (const [wrong, right] of Object.entries(corrections)) {
    cleaned = cleaned.replace(new RegExp(wrong, 'g'), right);
  }
  return cleaned;
}

function parseLinesToQuestions(lines) {
  const questionRegex = /^(\d+)[\)\.]\s*/;
  const optionRegex = /^[a-d][\)\.]\s*/i; // Restrict to a-d for four options
  const answerSectionRegex = /MOCK BOARD EXAM ANSWERS|ANSWERS AND SOLUTIONS|ANSWERS:/i;
  const answerTableRegex = /^\d+\.\s*[A-E]/i;
  const asteriskAnswerRegex = /\*\s*$/;

  let inAnswerSection = false;
  let answers = {};
  let newQuestions = [];
  let errors = [];
  let i = 0;

  lines = lines.map(line => cleanOCRText(line.trim())).filter(line => line);

  while (i < lines.length) {
    let line = lines[i];

    if (answerSectionRegex.test(line)) {
      inAnswerSection = true;
      i++;
      continue;
    }

    if (inAnswerSection) {
      if (answerTableRegex.test(line)) {
        const match = line.match(/^(\d+)\.\s*([A-E])/i);
        if (match) {
          answers[match[1]] = match[2];
        }
      }
      i++;
      continue;
    }

    let questionMatch = line.match(questionRegex);
    if (questionMatch) {
      let questionNumber = questionMatch[1];
      let questionText = line.replace(questionRegex, '').trim();
      let questionLines = [questionText];
      i++;

      while (
        i < lines.length &&
        !optionRegex.test(lines[i]) &&
        !questionRegex.test(lines[i]) &&
        !answerSectionRegex.test(lines[i])
      ) {
        questionLines.push(lines[i].trim());
        i++;
      }

      let options = [];
      let inlineAnswer = null;
      let expectedOptions = 4; // Expect exactly 4 options
      while (
        i < lines.length &&
        optionRegex.test(lines[i]) &&
        options.length < expectedOptions
      ) {
        let optionText = lines[i].replace(optionRegex, '').trim();
        let optionLines = [optionText];
        i++;
        while (
          i < lines.length &&
          !optionRegex.test(lines[i]) &&
          !questionRegex.test(lines[i]) &&
          !answerSectionRegex.test(lines[i]) &&
          lines[i].trim()
        ) {
          optionLines.push(lines[i].trim());
          i++;
        }
        let fullOptionText = optionLines.join(' ').trim();
        if (asteriskAnswerRegex.test(fullOptionText)) {
          inlineAnswer = String.fromCharCode(97 + options.length);
          fullOptionText = fullOptionText.replace(asteriskAnswerRegex, '').trim();
        }
        options.push(fullOptionText);
        console.log(`Question ${questionNumber}: Added option ${String.fromCharCode(97 + options.length - 1)}: ${fullOptionText}`);
      }

      let question = {
        questionNumber,
        question: questionLines.join(' ').trim(),
        options,
        answer: inlineAnswer || ''
      };

      if (options.length < 2) {
        errors.push(`Question ${questionNumber}: Only ${options.length} options found, skipping`);
      } else if (options.length !== expectedOptions) {
        errors.push(`Question ${questionNumber}: Found ${options.length} options, expected ${expectedOptions}`);
      }

      newQuestions.push(question);
      continue;
    }

    i++;
  }

  newQuestions.forEach(q => {
    if (answers[q.questionNumber] && !q.answer) {
      const answerIndex = 'ABCD'.indexOf(answers[q.questionNumber].toUpperCase());
      if (answerIndex >= 0 && answerIndex < q.options.length) {
        q.answer = String.fromCharCode(97 + answerIndex); // a, b, c, d
      }
    }
  });

  const validQuestions = newQuestions.filter(q => q.options.length >= 2 && q.answer);
  errors.push(`Parsed ${newQuestions.length} questions, ${validQuestions.length} valid`);

  console.log('Parsing complete:', {
    totalQuestions: newQuestions.length,
    validQuestions: validQuestions.length,
    errors
  });

  return { questions: validQuestions, errors };
}

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

async function parseText(content) {
  console.log('Parsing text content, length:', content.length);
  const lines = content.split('\n').map(line => line.trim()).filter(line => line);
  return parseLinesToQuestions(lines);
}

async function parseDocx(filePath) {
  console.log('Parsing DOCX file:', filePath);
  const result = await mammoth.extractRawText({ path: filePath });
  return parseText(result.value);
}

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

app.use((req, res, next) => {
  console.log(`Received ${req.method} request at ${req.path} from ${req.ip}`);
  next();
});

app.get('/api/questions', async (req, res) => {
  await loadQuestions();
  const randomizedQuestions = shuffleArray(questions);
  res.json(randomizedQuestions);
});

app.post('/api/reset', async (req, res) => {
  try {
    await loadQuestions();
    console.log('Quiz reset, reloaded questions:', questions.length);
    res.json({ message: 'Quiz reset successfully', questionCount: questions.length });
  } catch (error) {
    console.error('Error resetting quiz:', error.message);
    res.status(500).json({ message: 'Error resetting quiz: ' + error.message });
  }
});

app.post('/api/clear', async (req, res) => {
  try {
    if (!req.body.confirm || req.body.confirm !== 'DELETE') {
      return res.status(400).json({ message: 'Confirmation required: send { "confirm": "DELETE" } in request body' });
    }
    questions = [];
    await saveQuestions();
    console.log('Questions cleared, questions.json wiped');
    res.json({ message: 'Questions cleared successfully' });
  } catch (error) {
    console.error('Error clearing questions:', error.message);
    res.status(500).json({ message: 'Error clearing questions: ' + error.message });
  }
});

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

    let result = { questions: [], errors: [] };
    if (file.mimetype === 'application/pdf') {
      result = await parsePDF(filePath);
    } else if (file.mimetype === 'text/plain') {
      const content = await fs.readFile(filePath, 'utf8');
      result = await parseText(content);
    } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      result = await parseDocx(filePath);
    } else {
      console.log('Unsupported file type:', file.mimetype);
      return res.status(400).json({ message: 'Unsupported file type' });
    }

    questions = questions.concat(result.questions);
    await saveQuestions();
    await fs.unlink(filePath).catch(() => {});
    console.log('Upload complete, total questions:', questions.length);
    res.json({
      message: 'File parsed and questions added',
      questionsAdded: result.questions.length,
      errors: result.errors
    });
  } catch (error) {
    console.error('Error processing upload:', error.message);
    await fs.unlink(filePath).catch(() => {});
    res.status(500).json({ message: 'Error processing file: ' + error.message });
  }
});

app.listen(port, '0.0.0.0', async () => {
  console.log(`Server running at http://0.0.0.0:${port}`);
  await loadQuestions();
});