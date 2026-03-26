/**
 * Gemini AI Service
 * บริการ AI สำหรับการตอบคำถามอัจฉริยะ
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GEMINI_API_KEY);

// Enable Mock Mode for testing (set to false when API is ready)
const MOCK_MODE = process.env.GEMINI_MOCK_MODE === 'true';

// Default model configuration
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const DEFAULT_GENERATION_CONFIG = {
  temperature: parseFloat(process.env.GEMINI_TEMPERATURE) || 0.7,
  topP: parseFloat(process.env.GEMINI_TOP_P) || 0.95,
  topK: parseInt(process.env.GEMINI_TOP_K) || 40,
  maxOutputTokens: parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 1024,
};

// System instruction สำหรับ PCRU Chatbot (อ่านจาก .env)
const PCRU_SYSTEM_INSTRUCTION = process.env.PCRU_SYSTEM_INSTRUCTION;


/**
 * สร้าง Gemini model instance
 * @param {Object} options - ตัวเลือกการกำหนดค่า
 * @returns {GenerativeModel} - Gemini model instance
 */
function createModel(options = {}) {
  const {
    model = DEFAULT_MODEL,
    systemInstruction = PCRU_SYSTEM_INSTRUCTION,
    generationConfig = DEFAULT_GENERATION_CONFIG,
    useSearchGrounding = true,
  } = options;

  console.log(`🤖 Creating Gemini Model: ${model}`);
  console.log(`🔍 Google Search Grounding: ${useSearchGrounding ? 'Enabled' : 'Disabled'}`);

  const modelConfig = {
    model,
    systemInstruction,
    generationConfig,
  };

  // Enable Google Search Grounding for real-time web search
  if (useSearchGrounding) {
    modelConfig.tools = [{
      googleSearch: {}
    }];
  }

  return genAI.getGenerativeModel(modelConfig);
}

/**
 * ส่งข้อความถึง Gemini AI และรับคำตอบ
 * @param {string} message - ข้อความจากผู้ใช้
 * @param {Object} options - ตัวเลือกเพิ่มเติม
 * @returns {Promise<Object>} - คำตอบจาก AI
 */
async function chat(message, options = {}) {
  try {
    // Mock mode for testing before API is enabled
    if (MOCK_MODE) {
      console.log('🎭 Mock Mode Active - Simulating Gemini AI response');
      const mockResponses = [
        'สวัสดีครับ! ยินดีที่ได้ช่วยเหลือ',
        'ขอบคุณที่ถามนะครับ นี่คือคำตอบจากระบบ',
        'ถ้าหากคุณมีคำถามอื่น ผมยินดีที่จะช่วยเหลือครับ',
        'ขอให้มีวันที่ดีๆ ครับ',
      ];
      const randomResponse = mockResponses[Math.floor(Math.random() * mockResponses.length)];
      return {
        success: true,
        message: randomResponse,
        isMock: true,
        usage: {
          promptTokens: 10,
          candidateTokens: 15,
          totalTokens: 25,
        },
      };
    }

    const model = createModel(options);
    const result = await model.generateContent(message);
    const response = result.response;
    const text = response.text();

    return {
      success: true,
      message: text,
      usage: {
        promptTokens: result.response.usageMetadata?.promptTokenCount || 0,
        candidateTokens: result.response.usageMetadata?.candidatesTokenCount || 0,
        totalTokens: result.response.usageMetadata?.totalTokenCount || 0,
      },
    };
  } catch (error) {
    console.error('❌ Gemini AI Error:', error.message);
    
    // Detect quota errors
    const isQuotaError = error.message?.includes('429') || 
                        error.message?.includes('quota') || 
                        error.message?.includes('Too Many Requests');
    
    const quotaErrorDetails = {
      isQuotaExceeded: isQuotaError,
      retryAfter: extractRetryAfter(error.message),
      message: error.message
    };
    
    return {
      success: false,
      error: error.message,
      code: error.code || 'UNKNOWN_ERROR',
      quotaError: quotaErrorDetails,
    };
  }
}

// Helper function to extract retry-after time from error message
function extractRetryAfter(errorMessage) {
  if (!errorMessage) return null;
  const match = errorMessage.match(/retry in (\d+\.?\d*)(s|h|m)?/i);
  if (match) {
    const value = parseFloat(match[1]);
    const unit = (match[2] || 's').toLowerCase();
    
    let seconds = value;
    if (unit === 'h') seconds = value * 3600;
    else if (unit === 'm') seconds = value * 60;
    
    return Math.ceil(seconds);
  }
  return null;
}

/**
 * สร้าง chat session สำหรับการสนทนาต่อเนื่อง
 * @param {Object} options - ตัวเลือกการกำหนดค่า
 * @returns {ChatSession} - Chat session instance
 */
function createChatSession(options = {}) {
  const model = createModel(options);
  return model.startChat({
    history: options.history || [],
  });
}

/**
 * ส่งข้อความในรูปแบบ chat session (มีประวัติการสนทนา)
 * @param {ChatSession} chatSession - Chat session instance
 * @param {string} message - ข้อความจากผู้ใช้
 * @returns {Promise<Object>} - คำตอบจาก AI
 */
async function sendMessage(chatSession, message) {
  try {
    const result = await chatSession.sendMessage(message);
    const response = result.response;
    const text = response.text();

    return {
      success: true,
      message: text,
      usage: {
        promptTokens: result.response.usageMetadata?.promptTokenCount || 0,
        candidateTokens: result.response.usageMetadata?.candidatesTokenCount || 0,
        totalTokens: result.response.usageMetadata?.totalTokenCount || 0,
      },
    };
  } catch (error) {
    console.error('❌ Gemini Chat Error:', error.message);
    
    // Detect quota errors
    const isQuotaError = error.message?.includes('429') || 
                        error.message?.includes('quota') || 
                        error.message?.includes('Too Many Requests');
    
    const quotaErrorDetails = {
      isQuotaExceeded: isQuotaError,
      retryAfter: extractRetryAfter(error.message),
      message: error.message
    };
    
    return {
      success: false,
      error: error.message,
      quotaError: quotaErrorDetails,
      code: error.code || 'UNKNOWN_ERROR',
    };
  }
}

/**
 * ทดสอบการเชื่อมต่อกับ Gemini API
 * @returns {Promise<Object>} - ผลการทดสอบ
 */
async function testConnection() {
  try {
    if (MOCK_MODE) {
      return {
        success: true,
        message: 'เชื่อมต่อ Gemini API สำเร็จ (Mock Mode)',
        response: 'สวัสดีครับ',
        isMock: true,
        usage: {
          promptTokens: 10,
          candidateTokens: 15,
          totalTokens: 25,
        },
      };
    }

    const result = await chat('สวัสดี ตอบสั้นๆ ว่า "สวัสดีครับ" พอ');
    if (result.success) {
      return {
        success: true,
        message: 'เชื่อมต่อ Gemini API สำเร็จ',
        response: result.message,
        usage: result.usage,
      };
    }
    return result;
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

module.exports = {
  chat,
  createModel,
  createChatSession,
  sendMessage,
  testConnection,
  PCRU_SYSTEM_INSTRUCTION,
};
