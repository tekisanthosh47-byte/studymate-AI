
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static("."));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            "image/jpeg",
            "image/png",
            "image/webp"
        ];

        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error("Please upload a JPG, PNG or WebP image."));
        }
    }
});

// Store daily photo usage outside the public website folder.
const usageFile = path.join(
    os.homedir(),
    ".studymate-ai-photo-usage.json"
);

function getToday() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
}

function readUsage() {
    try {
        const data = JSON.parse(
            fs.readFileSync(usageFile, "utf8")
        );

        if (data.date === getToday()) {
            return data;
        }
    } catch (error) {
        // First run or no saved usage file yet.
    }

    return {
        date: getToday(),
        users: {}
    };
}

function writeUsage(data) {
    fs.writeFileSync(
        usageFile,
        JSON.stringify(data, null, 2),
        "utf8"
    );
}

function getUserId(req) {
    const id = req.get("x-user-id") || "";

    // Accept a UUID-style browser ID only.
    if (
        !/^[a-f0-9-]{36}$/i.test(id)
    ) {
        return null;
    }

    return id;
}

function createAnswerPrompt(question, type, subject) {
    let format;

    if (type === "2 Mark") {
        format =
            "Answer in simple English using 30 to 60 words. " +
            "Give a clear definition when appropriate and 1 or 2 " +
            "important points. Return only one 2-mark answer.";
    } else if (type === "5 Mark") {
        format =
            "Write one complete 5-mark answer in simple English, " +
            "approximately 120 to 180 words. Include an introduction " +
            "and 4 to 6 numbered points with explanations. " +
            "Return only the 5-mark answer.";
    } else if (type === "10 Mark") {
        format =
            "Write one complete 10-mark answer in simple English, " +
            "approximately 250 to 400 words. Include an introduction, " +
            "suitable headings, detailed points, examples where useful, " +
            "and a short conclusion. Return only the 10-mark answer.";
    } else {
        throw new Error(
            "Please select 2 Mark, 5 Mark or 10 Mark."
        );
    }

    return (
        "You are StudyMate AI, an engineering exam tutor. " +
        "Selected subject: " + subject + ". " +
        "Use simple, clear English and correct technical terms. " +
        "Do not invent facts. Follow the selected marks strictly. " +
        format + "\nQuestion: " + question
    );
}

async function askOllama(model, prompt, imageBase64) {
    const body = {
        model,
        prompt,
        stream: false
    };

    if (imageBase64) {
        body.images = [imageBase64];
    }

    const response = await fetch(
        "http://localhost:11434/api/generate",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        }
    );

    if (!response.ok) {
        throw new Error(
            model + " request failed. Check Ollama."
        );
    }

    const data = await response.json();

    if (!data.response || !data.response.trim()) {
        throw new Error(
            model + " returned an empty response."
        );
    }

    return data.response.trim();
}

// EXISTING TEXT QUESTION API
app.post("/generate", async (req, res) => {
    try {
        const question = req.body.question;
        const type = req.body.type;
        const subject = req.body.subject || "General";

        console.log("Selected Subject:", subject);
        console.log("Selected Type:", type);

        if (
            typeof question !== "string" ||
            !question.trim()
        ) {
            return res.status(400).json({
                error: "Please enter a question."
            });
        }

        const prompt = createAnswerPrompt(
            question.trim(),
            type,
            subject
        );

        const answer = await askOllama(
            "llama3.2:3b",
            prompt
        );

        res.json({ answer });
    } catch (error) {
        console.error("Text generation error:", error);

        res.status(500).json({
            error: error.message ||
                "AI connection failed. Make sure Ollama is running."
        });
    }
});

// NEW PHOTO QUESTION API
app.post(
    "/generate-from-photo",
    (req, res, next) => {
        upload.single("photo")(req, res, (error) => {
            if (error) {
                return res.status(400).json({
                    error: error.message
                });
            }

            next();
        });
    },
    async (req, res) => {
        let userId;
        let usageReserved = false;

        try {
            userId = getUserId(req);

            if (!userId) {
                return res.status(400).json({
                    error: "Browser ID missing. Refresh the page and try again."
                });
            }

            if (!req.file) {
                return res.status(400).json({
                    error: "Please select a question photo."
                });
            }

            const type = req.body.type;
            const subject = req.body.subject || "General";

            if (
                !["2 Mark", "5 Mark", "10 Mark"].includes(type)
            ) {
                return res.status(400).json({
                    error: "Please select 2 Mark, 5 Mark or 10 Mark."
                });
            }

            // Reserve one daily photo question on the server.
            const usage = readUsage();
            const used = usage.users[userId] || 0;

            if (used >= 5) {
                return res.status(429).json({
                    error: "Daily photo limit reached (5 of 5). Try again tomorrow.",
                    remaining: 0
                });
            }

            usage.users[userId] = used + 1;
            writeUsage(usage);
            usageReserved = true;

            // Moondream reads the question from the uploaded image.
            const imageBase64 = req.file.buffer.toString("base64");

            const extractedQuestion = await askOllama(
                "moondream:latest",
                "Read the text in this image. Extract the complete " +
                "exam question exactly as written. Preserve formulas " +
                "and important numbers. Do not answer the question. " +
                "Return only the question text. If no question is " +
                "visible, say NO_QUESTION_FOUND.",
                imageBase64
            );

            if (
                !extractedQuestion ||
                extractedQuestion.includes("NO_QUESTION_FOUND")
            ) {
                throw new Error(
                    "Could not find a question in the photo. Try a clearer image."
                );
            }

            // Existing text model generates the selected marks answer.
            const prompt = createAnswerPrompt(
                extractedQuestion,
                type,
                subject
            );

            const answer = await askOllama(
                "llama3.2:3b",
                prompt
            );

            res.json({
                question: extractedQuestion,
                answer,
                remaining: 5 - usage.users[userId]
            });
        } catch (error) {
            console.error("Photo generation error:", error);

            // Failed attempts do not consume the daily quota.
            if (usageReserved && userId) {
                try {
                    const usage = readUsage();
                    const used = usage.users[userId] || 0;

                    if (used > 0) {
                        usage.users[userId] = used - 1;
                        writeUsage(usage);
                    }
                } catch (saveError) {
                    console.error("Quota update error:", saveError);
                }
            }

            res.status(500).json({
                error: error.message ||
                    "Photo processing failed. Check that Ollama is running."
            });
        }
    }
);

// Handle upload errors, including oversized files.
app.use((error, req, res, next) => {
    console.error("Server error:", error);

    if (res.headersSent) {
        return next(error);
    }

    res.status(500).json({
        error: "An unexpected server error occurred."
    });
});

app.listen(PORT, function () {
    console.log(
        "StudyMate AI running at http://localhost:" + PORT
    );
});
