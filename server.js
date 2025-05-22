const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises;
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000; // Correctly use process.env.PORT as recommended by Render

app.use(fileUpload());
app.use(express.json()); // Added to parse JSON bodies
app.use(express.static('public')); // Serves static files from the 'public' directory

// CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE'); // Ensure DELETE is allowed for /api/clear-questions
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const uploadsDir = './uploads';
let questions = [];
const questionFile = 'questions.json'; // This file will store your questions

// --- Helper Functions for Questions ---

async function loadQuestions() {
  try {
    const data = await fs.readFile(questionFile, 'utf8');
    questions = JSON.parse(data);
    console.log('Loaded questions from', questionFile, ':', questions.length, 'questions');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('Question file not found, starting with empty questions array.');
      questions = [];
    } else {
      console.error('Error loading questions:', error.message);
    }
  }
}

async function saveQuestions() {
  try {
    await fs.writeFile(questionFile, JSON.stringify(questions, null, 2), 'utf8');
    console.log('Questions saved to', questionFile);
  } catch (error) {
    console.error('Error saving questions:', error.message);
  }
}

// --- Parsing Functions (from your existing code) ---

async function parsePDF(filePath) {
    let dataBuffer = await fs.readFile(filePath);
    const data = await pdfParse(dataBuffer);
    const text = data.text;
    console.log('[Parser] PDF text extracted:', text.substring(0, 200) + '...'); // Log first 200 chars

    return extractQuestionsAndAnswers(text);
}

async function parseText(content) {
    console.log('[Parser] Text content extracted:', content.substring(0, 200) + '...');
    return extractQuestionsAndAnswers(content);
}

async function parseDocx(filePath) {
    const { value } = await mammoth.extractRawText({ path: filePath });
    console.log('[Parser] DOCX text extracted:', value.substring(0, 200) + '...');
    return extractQuestionsAndAnswers(value);
}

function extractQuestionsAndAnswers(text) {
    const newQuestions = [];
    const errors = [];
    let currentQuestion = null;
    let optionLetters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']; // Support more options
    let answersFromSection = {}; // To store answers found in a dedicated 'Answers' section

    // Step 1: Extract answers from a dedicated 'Answers' section first
    const answerSectionRegex = /(?:ANSWERS?|SOLUTIONS?)\n\s*([\s\S]*?)(?=(?:\n\s*(?:[A-Z\s]+\n\s*(?:ANSWERS?|SOLUTIONS?))|\Z))/i;
    const answerMatch = text.match(answerSectionRegex);
    if (answerMatch && answerMatch[1]) {
        const answerText = answerMatch[1];
        console.log('[Parser] Found potential answer section:', answerText.substring(0, 100) + '...');
        // Regex to find patterns like "1. A", "2) B", "3 C", "4.C" (existing) AND "A 1", "B 2" (new)
        const answerLineRegex = /(?:(\d+)\s*[\.\)]?\s*([A-Z]))|(?:([A-Z])\s*(\d+))(?:\s|$)/g;
        let match;
        while ((match = answerLineRegex.exec(answerText)) !== null) {
            let qNum, answerLetter;
            if (match[1] && match[2]) { // Pattern: 1. A or 1) A
                qNum = match[1];
                answerLetter = match[2];
            } else if (match[3] && match[4]) { // Pattern: A 1
                answerLetter = match[3];
                qNum = match[4];
            }
            if (qNum && answerLetter) {
                answersFromSection[qNum] = answerLetter;
            }
        }
        console.log('[Parser] Answers from section:', answersFromSection);
    } else {
        console.log('[Parser] No dedicated answer section found. Will rely on inline answers if present.');
    }

    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const questionStartRegex = /^(\d+)\.\s*(.+)/; // e.g., "1. What is..." or "1) What is..."
    const optionRegex = /^([a-jA-J])[\.\)]\s*(.+)/; // e.g., "a. Option 1", "b) Option 2"

    let lastQuestionNumber = 0;

    for (const line of lines) {
        const questionMatch = line.match(questionStartRegex);
        if (questionMatch) {
            // If there's a current question, push it before starting a new one
            if (currentQuestion && currentQuestion.question && currentQuestion.options.length > 0) {
                // Check if currentQuestion.answer is undefined or invalid, and attempt to derive from options
                if (currentQuestion.correctAnswer === undefined) {
                    const inlineAnswerMatch = currentQuestion.question.match(/\s*Answer:\s*([a-jA-J])[\.\)]?$/i);
                    if (inlineAnswerMatch) {
                        const answerLetter = inlineAnswerMatch[1].toLowerCase();
                        const answerIndex = optionLetters.indexOf(answerLetter);
                        if (answerIndex !== -1 && answerIndex < currentQuestion.options.length) {
                            currentQuestion.correctAnswer = answerIndex;
                            currentQuestion.question = currentQuestion.question.replace(inlineAnswerMatch[0], '').trim(); // Remove answer from question text
                        }
                    } else if (currentQuestion.options.some(opt => opt.startsWith('*') || opt.startsWith('(*)'))) {
                        const starredOptionIndex = currentQuestion.options.findIndex(opt => opt.startsWith('*') || opt.startsWith('(*)'));
                        if (starredOptionIndex !== -1) {
                            currentQuestion.correctAnswer = starredOptionIndex;
                            currentQuestion.options[starredOptionIndex] = currentQuestion.options[starredOptionIndex].replace(/^\*?\s*\(\*\)\s*/, '').trim();
                        }
                    }
                }

                // Final check before pushing
                if (currentQuestion.correctAnswer !== undefined && currentQuestion.options.length > 0) {
                    newQuestions.push(currentQuestion);
                } else {
                    errors.push(`Incomplete question (Q${currentQuestion.questionNumber || 'N/A'}): "${currentQuestion.question}" - missing options or answer.`);
                }
            }

            const qNum = parseInt(questionMatch[1], 10);
            const qText = questionMatch[2].trim();

            if (qNum <= lastQuestionNumber && lastQuestionNumber !== 0) {
                 // Potentially a new section or malformed numbering. Reset for safety.
                console.warn(`[Parser] Detected non-sequential question number: ${qNum} after ${lastQuestionNumber}. Starting new sequence.`);
            }
            lastQuestionNumber = qNum;

            currentQuestion = {
                questionNumber: qNum.toString(),
                question: qText,
                options: [],
                correctAnswer: undefined // Will be set by inline marker or answer section
            };
        } else if (currentQuestion) {
            const optionMatch = line.match(optionRegex);
            if (optionMatch) {
                const optionLetter = optionMatch[1].toLowerCase();
                const optionText = optionMatch[2].trim();

                // Check for inline answer indication (e.g., "a. Option Text *")
                if (optionText.includes('*') || optionText.toLowerCase().includes('answer:')) {
                    if (currentQuestion.correctAnswer === undefined) { // Only set if not already determined by a previous method
                        const answerIndex = optionLetters.indexOf(optionLetter);
                        if (answerIndex !== -1) {
                            currentQuestion.correctAnswer = answerIndex;
                        }
                    }
                }
                currentQuestion.options.push(optionText.replace(/^\*?\s*\(\*\)\s*/, '').trim()); // Remove any leading markers
            } else if (currentQuestion.options.length > 0) {
                // If the line doesn't match an option, but we have options, it's likely a continuation of the last option
                currentQuestion.options[currentQuestion.options.length - 1] += ' ' + line;
            } else {
                // If no options yet, and not a new question, it might be a continuation of the question text
                currentQuestion.question += ' ' + line;
            }
        }
    }

    // Push the last question after the loop finishes
    if (currentQuestion && currentQuestion.question && currentQuestion.options.length > 0) {
        // Final check for the last question's answer
        if (currentQuestion.correctAnswer === undefined) {
            const inlineAnswerMatch = currentQuestion.question.match(/\s*Answer:\s*([a-jA-J])[\.\)]?$/i);
            if (inlineAnswerMatch) {
                const answerLetter = inlineAnswerMatch[1].toLowerCase();
                const answerIndex = optionLetters.indexOf(answerLetter);
                if (answerIndex !== -1 && answerIndex < currentQuestion.options.length) {
                    currentQuestion.correctAnswer = answerIndex;
                    currentQuestion.question = currentQuestion.question.replace(inlineAnswerMatch[0], '').trim();
                }
            } else if (currentQuestion.options.some(opt => opt.startsWith('*') || opt.startsWith('(*)'))) {
                const starredOptionIndex = currentQuestion.options.findIndex(opt => opt.startsWith('*') || opt.startsWith('(*)'));
                if (starredOptionIndex !== -1) {
                    currentQuestion.correctAnswer = starredOptionIndex;
                    currentQuestion.options[starredOptionIndex] = currentQuestion.options[starredOptionIndex].replace(/^\*?\s*\(\*\)\s*/, '').trim();
                }
            }
        }
        if (currentQuestion.correctAnswer !== undefined && currentQuestion.options.length > 0) {
            newQuestions.push(currentQuestion);
        } else {
            errors.push(`Incomplete question (Q${currentQuestion.questionNumber || 'N/A'}): "${currentQuestion.question}" - missing options or answer (last question).`);
        }
    }

    // Post-processing: Assign correct answers from the answer section (overwrites inline if found, but inline is prioritized if found first)
    newQuestions.forEach(q => {
        // Only assign from section if not already set by inline '*' or 'Answer:'
        if (q.correctAnswer === undefined && answersFromSection[q.questionNumber]) {
            const answerLetter = answersFromSection[q.questionNumber].toLowerCase(); // Convert to lowercase for consistency
            const answerIndex = optionLetters.indexOf(answerLetter); // Convert a, b, c, d to 0, 1, 2, 3
            if (answerIndex !== -1 && answerIndex < q.options.length) {
                q.correctAnswer = answerIndex;
            } else {
                errors.push(`Answer for Q${q.questionNumber} (${answerLetter}) from section not found in options or invalid index.`);
            }
        } else if (q.correctAnswer === undefined) {
            errors.push(`No answer found for Q${q.questionNumber} in document or section.`);
        }
    });

    console.log(`[Parser] Final parsed questions count: ${newQuestions.length}`);
    return { questions: newQuestions, errors: errors };
}


// --- Routes ---

app.post('/api/upload', async (req, res) => {
  if (!req.files || Object.keys(req.files).length === 0) {
    return res.status(400).json({ message: 'No files were uploaded.' });
  }

  const file = req.files.file;
  const category = req.body.category || 'Default Category'; // Get category from form data
  const filePath = path.join(uploadsDir, file.name);
  console.log('Received file:', file.name, 'Saving to:', filePath, 'for category:', category);

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
      await fs.unlink(filePath).catch(() => {}); // Attempt to delete unsupported file
      return res.status(400).json({ message: 'Unsupported file type' });
    }

    // Assign category to each parsed question
    const categorizedQuestions = result.questions.map(q => ({ ...q, category: category }));
    questions = questions.concat(categorizedQuestions);
    await saveQuestions();
    await fs.unlink(filePath).catch(() => {}); // Clean up uploaded file
    console.log('Upload complete, total questions:', questions.length);
    res.json({
      message: 'File parsed and questions added',
      questionsAdded: result.questions.length,
      errors: result.errors,
      totalQuestions: questions.length // Send total questions back
    });
  } catch (error) {
    console.error('Error processing upload:', error.message);
    await fs.unlink(filePath).catch(() => {}); // Clean up even on error
    res.status(500).json({ message: 'Error processing file', error: error.message });
  }
});


app.get('/api/questions', (req, res) => {
  // Group questions by category for the frontend
  const categorizedQuestions = questions.reduce((acc, q) => {
    (acc[q.category] = acc[q.category] || []).push(q);
    return acc;
  }, {});
  res.json(categorizedQuestions);
});

// New route to clear all questions
app.delete('/api/clear-questions', async (req, res) => {
  questions = [];
  await saveQuestions();
  console.log('All questions cleared.');
  res.json({ message: 'All questions cleared.' });
});

// --- Server Initialization ---

// Ensure the uploads directory exists and then start the server
fs.mkdir(uploadsDir, { recursive: true })
  .then(() => {
    console.log('Uploads directory ensured:', uploadsDir);
    // Load questions after directory is ensured and BEFORE starting the server
    return loadQuestions();
  })
  .then(() => {
    // Start the server ONLY after the directory is ensured and questions are loaded
    app.listen(port, () => {
      console.log(`Server listening on port ${port}`);
    });
  })
  .catch(err => {
    console.error('Error during server startup (directory or question loading):', err);
    // Exit the process if critical setup fails
    process.exit(1);
  });