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
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE'); // Ensure DELETE is allowed
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
    if (error.code === 'ENOENT') {
      console.log('questions.json not found, starting with empty questions array.');
      questions = [];
    } else {
      console.error('Error loading questions:', error);
    }
  }
}

async function saveQuestions() {
  try {
    await fs.writeFile(questionFile, JSON.stringify(questions, null, 2), 'utf8');
    console.log('Questions saved to', questionFile);
  } catch (error) {
    console.error('Error saving questions:', error);
  }
}

// Helper to parse PDF content
async function parsePDF(filePath, uploadCategory) {
    console.log(`Parsing PDF: ${filePath} with upload category: ${uploadCategory}`);
    let errors = [];
    try {
        const dataBuffer = await fs.readFile(filePath);
        const data = await pdfParse(dataBuffer);
        const textContent = data.text;
        return parseText(textContent, uploadCategory); // Delegate to parseText for actual logic
    } catch (e) {
        console.error(`Error parsing PDF ${filePath}:`, e);
        errors.push(`Error parsing PDF: ${e.message}`);
    }
    return { questions: [], errors: errors };
}

// Helper to parse DOCX content
async function parseDocx(filePath, uploadCategory) {
    console.log(`Parsing DOCX: ${filePath} with upload category: ${uploadCategory}`);
    let errors = [];
    try {
        const { value, messages } = await mammoth.extractRawText({ path: filePath });
        if (messages) {
            messages.forEach(msg => errors.push(`DOCX parsing warning/error: ${msg.message}`));
        }
        return parseText(value, uploadCategory); // Delegate to parseText for actual logic
    } catch (e) {
        console.error(`Error parsing DOCX ${filePath}:`, e);
        errors.push(`Error parsing DOCX: ${e.message}`);
    }
    return { questions: [], errors: errors };
}

// Centralized parsing logic for text content (from PDF, DOCX, or TXT)
async function parseText(text, uploadCategory) {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const newQuestions = [];
    const errors = [];
    let currentQuestion = null;
    let inOptions = false;
    let detectedCategory = uploadCategory || "UNCATEGORIZED"; // Use uploadCategory as primary, fallback to UNCATEGORIZED

    // Attempt to extract category from the first few lines of the document
    for (let i = 0; i < Math.min(lines.length, 10); i++) { // Check first 10 lines
        const categoryMatch = lines[i].match(/MOCK BOARD EXAMINATION IN\s*([A-Z\s]+)/i);
        if (categoryMatch && categoryMatch[1]) {
            detectedCategory = categoryMatch[1].trim().replace(/\(.*\)/g, '').trim().toUpperCase(); // Remove parentheses and convert to uppercase
            console.log(`[Parser] Detected category from document: ${detectedCategory}`);
            break;
        }
    }

    // Regex for answer section headers (to skip or extract answers from)
    const answerSectionHeaderRegex = /MOCK BOARD EXAM ANSWERS|ANSWERS AND SOLUTIONS|ANSWERS:|SOLUTION(?:S)?:/i;
    // Regex for individual answers in an answer section (e.g., "1. B", "45. A")
    const answerLineRegex = /^(\d+)\.\s*([A-Ea-e])/;
    let answersFromSection = {}; // To store answers from a dedicated section

    let inAnswerSection = false;

    for (const line of lines) {
        // Check if we are entering an answer section
        if (answerSectionHeaderRegex.test(line)) {
            inAnswerSection = true;
            console.log(`[Parser] Entering answer section.`);
            continue; // Skip the header line itself
        }

        // If in answer section, parse answers
        if (inAnswerSection) {
            const answerMatch = line.match(answerLineRegex);
            if (answerMatch) {
                const qNum = parseInt(answerMatch[1], 10);
                const ansLetter = answerMatch[2].toUpperCase();
                answersFromSection[qNum] = ansLetter;
                // console.log(`[Parser] Parsed answer from section: Q${qNum} -> ${ansLetter}`);
            } else {
                // Heuristic: If we see a line that doesn't look like an answer after being in the answer section,
                // it might mean the answer section has ended. This is a simple heuristic.
                // You might need more sophisticated logic based on your document structure.
                // if (Object.keys(answersFromSection).length > 0 && !line.match(/^\d+/) && !line.match(/^[a-zA-Z]/)) {
                //     inAnswerSection = false; // Uncomment this if you want strict answer section boundaries
                // }
            }
            continue; // Continue to next line if in answer section
        }


        // New question pattern (e.g., "1) What is...", "1. What is...")
        const questionMatch = line.match(/^(\d+)[).]\s*(.*)/);
        if (questionMatch) {
            if (currentQuestion) {
                // Before pushing the old question, ensure it's complete
                if (currentQuestion.question && currentQuestion.options.length >= 2 && currentQuestion.correctAnswer !== undefined) {
                    newQuestions.push(currentQuestion);
                } else {
                    errors.push(`Incomplete question (Q${currentQuestion.questionNumber || 'N/A'}): "${currentQuestion.question}" - missing options or answer.`);
                }
            }
            currentQuestion = {
                questionNumber: questionMatch[1],
                question: questionMatch[2].trim(),
                options: [],
                correctAnswer: undefined, // Will be set from answer section or inline
                category: detectedCategory // Assign detected category
            };
            inOptions = true; // Assume next lines are options
        } else if (inOptions && line.match(/^[a-dA-D][).]\s*/)) { // Options (e.g., "a) Option text", "A. Option text")
            const optionMatch = line.match(/^[a-dA-D][).]\s*(.*)/);
            if (currentQuestion && optionMatch) {
                currentQuestion.options.push(optionMatch[1].trim());
            }
        } else if (line.toLowerCase().startsWith('answer:') || line.toLowerCase().startsWith('ans:')) {
            const answerMatch = line.match(/(?:answer|ans):\s*([a-dA-D])/i);
            if (currentQuestion && answerMatch) {
                currentQuestion.correctAnswer = answerMatch[1].toLowerCase().charCodeAt(0) - 'a'.charCodeAt(0);
                inOptions = false; // Assume options are done after inline answer
            }
        } else if (currentQuestion && inOptions) {
            // If it's not a new question or an option, and we're still in options, it's part of the previous option or question
            if (currentQuestion.options.length > 0) {
                currentQuestion.options[currentQuestion.options.length - 1] += ' ' + line;
            } else if (currentQuestion.question) {
                currentQuestion.question += ' ' + line;
            }
        } else if (currentQuestion) {
            // If not an option, and not inOptions mode, but we have a current question, assume it's more question text
            currentQuestion.question += ' ' + line;
        }
    }

    // Add the last question if it exists and is complete
    if (currentQuestion) {
        if (currentQuestion.question && currentQuestion.options.length >= 2 && currentQuestion.correctAnswer !== undefined) {
            newQuestions.push(currentQuestion);
        } else {
            errors.push(`Incomplete question (Q${currentQuestion.questionNumber || 'N/A'}): "${currentQuestion.question}" - missing options or answer (last question).`);
        }
    }

    // Post-processing: Assign correct answers from the answer section (overwrites inline if found)
    newQuestions.forEach(q => {
        if (answersFromSection[q.questionNumber]) {
            const answerLetter = answersFromSection[q.questionNumber];
            const answerIndex = 'ABCD'.indexOf(answerLetter); // Convert A, B, C, D to 0, 1, 2, 3
            if (answerIndex !== -1 && answerIndex < q.options.length) {
                q.correctAnswer = answerIndex;
                // console.log(`[Parser] Assigned correct answer for Q${q.questionNumber} from section: ${answerLetter} (index ${answerIndex})`);
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


// Initial load of questions when server starts
loadQuestions();

// API Endpoints
app.get('/api/questions', (req, res) => {
  res.json(questions);
});

app.post('/api/upload', async (req, res) => {
  if (!req.files || Object.keys(req.files).length === 0) {
    return res.status(400).json({ message: 'No files were uploaded.' });
  }

  const file = req.files.file;
  const uploadCategory = req.body.category || 'UNCATEGORIZED'; // Get category from form data
  const filePath = path.join(uploadsDir, file.name);
  console.log('Received file:', file.name, 'Saving to:', filePath, 'with upload category:', uploadCategory);

  try {
    await file.mv(filePath);
    console.log('File moved to:', filePath);

    let result = { questions: [], errors: [] };
    if (file.mimetype === 'application/pdf') {
      result = await parsePDF(filePath, uploadCategory);
    } else if (file.mimetype === 'text/plain') {
      const content = await fs.readFile(filePath, 'utf8');
      result = await parseText(content, uploadCategory);
    } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      result = await parseDocx(filePath, uploadCategory);
    } else {
      console.log('Unsupported file type:', file.mimetype);
      return res.status(400).json({ message: 'Unsupported file type. Please upload .txt, .pdf, or .docx files.' });
    }

    // Filter out duplicate questions before adding
    const existingQuestionIdentifiers = new Set(questions.map(q => `${q.category}-${q.questionNumber}-${q.question}`));
    const uniqueNewQuestions = result.questions.filter(q => {
        // Ensure question has a category, number, and text to form a unique identifier
        if (!q.category || !q.questionNumber || !q.question) {
            result.errors.push(`Skipped malformed question: missing category, number, or text.`);
            return false;
        }
        const identifier = `${q.category}-${q.questionNumber}-${q.question}`;
        if (existingQuestionIdentifiers.has(identifier)) {
            result.errors.push(`Duplicate question skipped (Q${q.questionNumber} in ${q.category}).`);
            return false;
        }
        existingQuestionIdentifiers.add(identifier);
        return true;
    });

    questions = questions.concat(uniqueNewQuestions);
    await saveQuestions();
    await fs.unlink(filePath).catch((err) => console.error(`Error deleting uploaded file ${filePath}:`, err)); // More robust deletion
    console.log('Upload complete, questions added:', uniqueNewQuestions.length, 'total questions:', questions.length);
    res.json({
      message: 'File parsed and questions added',
      questionsAdded: uniqueNewQuestions.length,
      errors: result.errors,
      totalQuestions: questions.length
    });
  } catch (error) {
    console.error('Error processing upload:', error);
    await fs.unlink(filePath).catch((err) => console.error(`Error deleting uploaded file ${filePath} after processing error:`, err));
    res.status(500).json({ message: `Error processing file: ${error.message}` });
  }
});

app.delete('/api/questions', async (req, res) => {
  try {
    questions = []; // Clear the in-memory questions array
    await saveQuestions(); // Save the empty array to questions.json
    console.log('All questions cleared.');
    res.json({ message: 'All questions cleared successfully.' });
  } catch (error) {
    console.error('Error clearing questions:', error);
    res.status(500).json({ message: `Error clearing questions: ${error.message}` });
  }
});

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});