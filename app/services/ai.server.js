import { GoogleGenerativeAI } from "@google/generative-ai";

const MAX_IMAGE_SIZE = 10_000_000; // 10MB
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;

let _genAI = null;
function getGenAI() {
  if (!_genAI) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not configured. Add it to your .env file.");
    }
    _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return _genAI;
}

async function fetchImageAsBase64(imageUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(imageUrl, { signal: controller.signal });

    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_IMAGE_SIZE) {
      throw new Error("Image is too large (max 10MB)");
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_IMAGE_SIZE) {
      throw new Error("Image is too large (max 10MB)");
    }

    return {
      data: Buffer.from(buffer).toString("base64"),
      mimeType: response.headers.get("content-type") || "image/jpeg",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callGeminiWithRetry(model, content) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await model.generateContent(content);
      const text = result.response.text();
      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

      try {
        return JSON.parse(cleaned);
      } catch (parseError) {
        throw new Error(
          `Invalid response from AI model. The output was not valid JSON. Please try again.`
        );
      }
    } catch (error) {
      lastError = error;

      // Don't retry on parse errors or non-retryable errors
      if (error.message.includes("Invalid response") || attempt === MAX_RETRIES) {
        throw error;
      }

      // Exponential backoff: 1s, 2s, 4s
      const delay = Math.pow(2, attempt - 1) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

export async function generateListing({ imageUrl, imageBase64, imageMimeType }) {
  const genAI = getGenAI();
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      responseMimeType: "application/json",
    },
  });

  let base64Data, mimeType;

  if (imageBase64) {
    base64Data = imageBase64;
    mimeType = imageMimeType || "image/jpeg";
  } else {
    const image = await fetchImageAsBase64(imageUrl);
    base64Data = image.data;
    mimeType = image.mimeType;
  }

  const prompt = `You are an expert Shopify product copywriter. Analyze this product image and generate a complete, optimized product listing.

Return ONLY valid JSON with this exact structure (no markdown, no code fences):
{
  "title": "A compelling, SEO-friendly product title (under 70 characters)",
  "description": "A persuasive product description (2-3 paragraphs, HTML formatted with <p> tags)",
  "bullets": ["Key feature or benefit 1", "Key feature or benefit 2", "Key feature or benefit 3", "Key feature or benefit 4", "Key feature or benefit 5"],
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "seoTitle": "SEO meta title (under 60 characters)",
  "seoDescription": "SEO meta description (under 155 characters)"
}

Guidelines:
- Identify the product type, material, color, and key features from the image
- Write copy that sells — focus on benefits, not just features
- Use natural language that a real merchant would use
- Tags should be relevant for Shopify search and collections
- SEO fields should target keywords a shopper would search for`;

  return callGeminiWithRetry(model, [
    prompt,
    {
      inlineData: {
        mimeType,
        data: base64Data,
      },
    },
  ]);
}
