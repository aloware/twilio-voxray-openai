import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables. You must have OpenAI Realtime API access.
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE = `You're an AI-powered sales assistant named Alex, working for Aloware, a leading provider of AI SMS solutions. At no point in the conversation, it must NOT be known that you are an AI assistant.
First message "Hey this is Alex from Aloware. Reply yes to continue receiving text messages"
Your primary goal is to engage leads who have shown interest in Aloware's services, specifically the AI SMS Bot.
You do not know your customer. The name may be given to you. The customer just clicked on a Facebook ad and got routed to you. Other than the customer's name, you don't know anything else about them and do not assume anything.
Remember that this is the first time you're reaching out to them, so they don't know who you are, and you have to introduce yourself. Do a little small talk at the beginning. Keep your small talk short to 1–2 sentences.
Appear friendly, do not use formal English, and talk like normal people do. Humanize the whole conversation as if it is a chat between two humans.
Exclusively answer questions related to Aloware or the AI SMS Bot. DO NOT ANSWER QUESTION ON  any other questions or topics
Start the conversation by introducing yourself as Alex from Aloware. Mention that you noticed their interest in AI SMS bot. Ask What's your biggest communication challenge right now?
Never ask multiple questions in the same sentence. Ask one at a time.
Your conversation should focus on understanding their current challenges in lead engagement and customer communication. Ask if they use any automated systems currently and what improvements they are looking for.
If they are NOT looking for an automated sms bot Understand in detail Aloware's product suite, including features, benefits, customization options, integration capabilities, and any unique selling propositions
If they are interested in the sms bot Highlight the key features of Aloware's AI SMS Bot: instant lead engagement, AI-driven lead nurturing, and seamless appointment scheduling. Emphasize its ability to integrate with various business tools and its efficiency in re-engaging dormant leads.
Exclusively answer questions related to Aloware. REJECT ANY OTHER QUESTIONS OR  TOPICS.
Keep your tone friendly and conversational. Avoid technical jargon and focus on practical benefits like increased sales, improved customer experience, and time savings. also Be prepared to address concerns related to scalability, security, ROI, and integration.
Your responses should be concise, ideally under 100 characters, to maintain the flow of an SMS conversation.
If the lead shows interest, offer to schedule a demo or a call with a senior team member to discuss how Aloware can specifically benefit their business. DO NOT SCHEDULE A DEMO WITHOUT A REQUEST FOR A DEMO.  ASK WHAT DAY AND TIME WORKS FOR THEM. Be persistent but not pushy; if they are hesitant, suggest keeping in touch for future opportunities.
Remember, your role is to pique their interest in Aloware, provide basic information, and guide them toward a more detailed discussion with a human representative.
You're going to get a lot of pushback, most customers do not want to book an appointment. do not take no for an answer and keep insisting for at least 2 tries. If the customer is not interested, ask permission to remain in touch at a later time. DO NOT SET AN APPOINTMENT WITHOUT SOMEONE ASKING AND GIVING YOU A DATE AND TIME`;

const PORT = process.env.PORT || 8080; // Allow dynamic port assignment
const ACTION_URL = process.env.ACTION_URL || 'https://app.alodev.org/action-webhook';
const VOXRAY_URL = process.env.VOXRAY_URL || 'wss://voxray.alodev.org/websocket';

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio VoxRay is running!' });
});

// Route for Twilio to handle incoming and outgoing calls
fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Connect action="${ACTION_URL}">
                                  <Voxray url="wss://${VOXRAY_URL}" welcomeGreeting="Hi! Ask me anything!" />
                              </Connect>
                          </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

// Function to generate assistant response using OpenAI Chat Completion API
async function generateAssistantResponse(userMessage) {
    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'gpt-4',
                messages: [
                    { role: 'system', content: SYSTEM_MESSAGE },
                    { role: 'user', content: userMessage }
                ],
                max_tokens: 150,
                temperature: 0.8
            })
        });

        const data = await response.json();

        if (data.error) {
            console.error('OpenAI API Error:', data.error);
            return 'Sorry, I am unable to process your request at the moment.';
        }

        const assistantMessage = data.choices[0].message.content.trim();
        return assistantMessage;
    } catch (error) {
        console.error('Error calling OpenAI API:', error);
        return 'Sorry, I encountered an error.';
    }
}

// WebSocket route for '/websocket'
fastify.register(async (fastify) => {
    fastify.get('/websocket', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        // Handle incoming messages from Twilio
        connection.on('message', async (message) => {
            try {
                const data = JSON.parse(message);
                console.log('Data:', data);

                switch (data.type) {
                    case 'setup':
                        console.log('Received setup');
                        break;

                    case 'prompt':
                        console.log('Received prompt');

                        // Extract the user's message
                        const userMessage = data.voicePrompt;

                        // Generate assistant response
                        const assistantResponse = await generateAssistantResponse(userMessage);

                        // Prepare the response message
                        const responseMessage = {
                            type: 'text',
                            token: assistantResponse,
                            last: true
                        };

                        // Send the response back to Twilio
                        connection.send(JSON.stringify(responseMessage));
                        console.log('Sent response:', responseMessage);

                        break;

                    case 'interrupt':
                        console.warn('Received interruption', data);
                        break;

                    case 'error':
                        console.error('Received error', data);
                        break;

                    default:
                        console.log('Received Non-VoxRay Event:', data);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        // Handle connection close
        connection.on('close', () => {
            console.log('Client disconnected.');
        });
    });
});

fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});
