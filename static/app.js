document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const sidebar = document.getElementById('sidebar');
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const newChatBtn = document.getElementById('new-chat-btn');
    const chatHistoryList = document.getElementById('chat-history-list');
    const modelSelect = document.getElementById('model-select');
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const statusDesc = document.getElementById('status-desc');
    const currentChatTitle = document.getElementById('current-chat-title');
    const currentChatModel = document.getElementById('current-chat-model');
    const clearChatBtn = document.getElementById('clear-chat-btn');
    const messagesContainer = document.getElementById('messages-container');
    const welcomeScreen = document.getElementById('welcome-screen');
    const chatForm = document.getElementById('chat-form');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    const suggestionCards = document.querySelectorAll('.suggestion-card');

    // App State
    let chats = []; // Loaded from MongoDB API
    let currentChatId = null;
    let isGenerating = false;
    let isApiKeyConfigured = false;
    let isDbConnected = false;

    // Initialize UI
    init();

    async function init() {
        // Fetch API & Database configuration status
        await checkConfig();
        
        // Fetch chat history from MongoDB
        await fetchChatsFromDB();
        
        // Auto-select first chat or start fresh
        if (chats.length > 0) {
            await loadChat(chats[0].id);
        } else {
            showWelcomeScreen();
        }

        // Set up Event Listeners
        setupEventListeners();
    }

    async function checkConfig() {
        try {
            const res = await fetch('/api/config');
            const data = await res.json();
            
            isApiKeyConfigured = data.is_api_key_configured;
            isDbConnected = data.is_db_connected;
            
            // Populate models if available
            if (data.available_models) {
                modelSelect.innerHTML = data.available_models.map(m => 
                    `<option value="${m.id}">${m.name}</option>`
                ).join('');
            }
            
            if (isApiKeyConfigured && isDbConnected) {
                statusDot.className = 'status-dot active';
                statusText.innerText = 'Connected';
                statusDesc.innerText = 'API & MongoDB Atlas Online';
            } else if (!isApiKeyConfigured) {
                statusDot.className = 'status-dot error';
                statusText.innerText = 'API Key Required';
                statusDesc.innerText = 'Set GROQ_API_KEY in .env';
            } else {
                statusDot.className = 'status-dot error';
                statusText.innerText = 'Database Offline';
                statusDesc.innerText = 'Check MONGO_URI in .env';
            }
        } catch (e) {
            console.error('Failed to fetch config:', e);
            statusDot.className = 'status-dot error';
            statusText.innerText = 'Connection Error';
            statusDesc.innerText = 'Backend API is unreachable';
        }
    }

    async function fetchChatsFromDB() {
        try {
            const res = await fetch('/api/chats');
            if (res.ok) {
                chats = await res.json();
            }
        } catch (e) {
            console.error('Failed to fetch chats from database:', e);
            chats = [];
        }
    }

    function setupEventListeners() {
        // Sidebar Toggle on Mobile
        sidebarToggle.addEventListener('click', () => {
            sidebar.classList.toggle('open');
        });

        // Close sidebar when clicking outside on mobile
        document.addEventListener('click', (e) => {
            if (window.innerWidth <= 768) {
                if (!sidebar.contains(e.target) && !sidebarToggle.contains(e.target) && sidebar.classList.contains('open')) {
                    sidebar.classList.remove('open');
                }
            }
        });

        // New Chat Button
        newChatBtn.addEventListener('click', () => {
            createNewChat();
            if (window.innerWidth <= 768) sidebar.classList.remove('open');
        });

        // Clear Current Chat Button (Re-initialize message list to empty in database)
        clearChatBtn.addEventListener('click', async () => {
            if (currentChatId) {
                if (confirm('Are you sure you want to clear all messages in this conversation?')) {
                    try {
                        // We delete the chat and create a new clean one with the same ID
                        const chat = chats.find(c => c.id === currentChatId);
                        if (!chat) return;
                        
                        await fetch(`/api/chats/${currentChatId}`, { method: 'DELETE' });
                        await fetch('/api/chats', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                id: currentChatId,
                                title: chat.title,
                                model: chat.model
                            })
                        });
                        
                        await loadChat(currentChatId);
                    } catch (e) {
                        console.error('Failed to clear chat:', e);
                    }
                }
            }
        });

        // Dropdown model selection updates active chat model
        modelSelect.addEventListener('change', () => {
            if (currentChatId) {
                const chat = chats.find(c => c.id === currentChatId);
                if (chat) {
                    chat.model = modelSelect.value;
                    currentChatModel.innerText = modelSelect.options[modelSelect.selectedIndex].text;
                }
            }
        });

        // Form Submit
        chatForm.addEventListener('submit', (e) => {
            e.target.reportValidity();
            e.preventDefault();
            handleMessageSubmit();
        });

        // Textarea adjustments (auto-grow & submit on Enter)
        userInput.addEventListener('input', () => {
            adjustTextareaHeight();
            toggleSendButton();
        });

        userInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!sendBtn.disabled && !isGenerating) {
                    handleMessageSubmit();
                }
            }
        });

        // Suggestion Cards
        suggestionCards.forEach(card => {
            card.addEventListener('click', () => {
                const prompt = card.getAttribute('data-prompt');
                userInput.value = prompt;
                adjustTextareaHeight();
                toggleSendButton();
                handleMessageSubmit();
            });
        });
    }

    function adjustTextareaHeight() {
        userInput.style.height = 'auto';
        userInput.style.height = `${userInput.scrollHeight}px`;
    }

    function toggleSendButton() {
        sendBtn.disabled = userInput.value.trim() === '' || isGenerating;
    }

    // State Management & Rendering
    async function createNewChat() {
        if (!isDbConnected) {
            alert('Cannot create chat: Database connection is offline. Please check your .env settings.');
            return;
        }

        const id = Date.now().toString();
        const newChat = {
            id: id,
            title: 'New Conversation',
            model: modelSelect.value
        };

        try {
            const res = await fetch('/api/chats', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newChat)
            });

            if (res.ok) {
                chats.unshift(newChat);
                renderChatHistory();
                await loadChat(id);
            } else {
                console.error('Failed to register chat in database');
            }
        } catch (e) {
            console.error('Failed to create chat:', e);
        }
    }

    async function loadChat(id) {
        currentChatId = id;
        
        try {
            const res = await fetch(`/api/chats/${id}`);
            if (!res.ok) {
                throw new Error('Chat session not found in database');
            }
            
            const chat = await res.json();
            
            // Update active class in sidebar
            const items = chatHistoryList.querySelectorAll('.history-item');
            items.forEach(item => {
                if (item.getAttribute('data-id') === id) {
                    item.classList.add('active');
                } else {
                    item.classList.remove('active');
                }
            });

            // Update header details
            currentChatTitle.innerText = chat.title;
            modelSelect.value = chat.model;
            const selectedModelText = modelSelect.options[modelSelect.selectedIndex]?.text || chat.model;
            currentChatModel.innerText = selectedModelText;

            // Clear container and render messages
            messagesContainer.innerHTML = '';
            if (!chat.messages || chat.messages.length === 0) {
                showWelcomeScreen();
            } else {
                welcomeScreen.style.display = 'none';
                chat.messages.forEach(msg => {
                    appendMessage(msg.role, msg.content);
                });
                scrollToBottom();
            }
        } catch (e) {
            console.error('Failed to load chat:', e);
            showWelcomeScreen();
        }
    }

    function showWelcomeScreen() {
        welcomeScreen.style.display = 'flex';
        messagesContainer.innerHTML = '';
        messagesContainer.appendChild(welcomeScreen);
        currentChatTitle.innerText = 'New Conversation';
        currentChatModel.innerText = modelSelect.options[modelSelect.selectedIndex]?.text || 'Llama 3.3 70B';
    }

    function renderChatHistory() {
        if (chats.length === 0) {
            chatHistoryList.innerHTML = `
                <div style="text-align: center; color: var(--text-muted); font-size: 13px; padding: 20px 0;">
                    No recent conversations
                </div>
            `;
            return;
        }

        chatHistoryList.innerHTML = chats.map(chat => `
            <div class="history-item ${chat.id === currentChatId ? 'active' : ''}" data-id="${chat.id}">
                <div class="history-title-wrapper">
                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                    </svg>
                    <span class="history-title">${chat.title}</span>
                </div>
                <button class="delete-history-btn" data-id="${chat.id}" title="Delete chat">
                    <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
            </div>
        `).join('');

        // History item click listeners
        chatHistoryList.querySelectorAll('.history-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.delete-history-btn')) return;
                loadChat(item.getAttribute('data-id'));
            });
        });

        // Delete button listeners
        chatHistoryList.querySelectorAll('.delete-history-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.getAttribute('data-id');
                deleteChat(id);
            });
        });
    }

    async function deleteChat(id) {
        if (confirm('Delete this conversation?')) {
            try {
                const res = await fetch(`/api/chats/${id}`, { method: 'DELETE' });
                if (res.ok) {
                    chats = chats.filter(c => c.id !== id);
                    renderChatHistory();
                    
                    if (currentChatId === id) {
                        if (chats.length > 0) {
                            await loadChat(chats[0].id);
                        } else {
                            currentChatId = null;
                            showWelcomeScreen();
                        }
                    }
                } else {
                    alert('Failed to delete chat session.');
                }
            } catch (e) {
                console.error('Failed to delete chat:', e);
            }
        }
    }

    function appendMessage(role, content) {
        welcomeScreen.style.display = 'none';

        const wrapper = document.createElement('div');
        wrapper.className = `message-wrapper ${role}`;

        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        if (role === 'user') {
            avatar.innerText = 'U';
        } else {
            avatar.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 2a10 10 0 0 1 7.54 16.59c-.24.25-.34.58-.29.91l.7 4.5a.5.5 0 0 1-.75.52l-4.22-2.11a1 1 0 0 0-.44-.1H12A10 10 0 1 1 12 2z"/>
                    <circle cx="12" cy="12" r="3"/>
                </svg>
            `;
        }

        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        bubble.innerHTML = role === 'user' ? escapeHtml(content).replace(/\n/g, '<br>') : parseMarkdown(content);

        wrapper.appendChild(avatar);
        wrapper.appendChild(bubble);
        messagesContainer.appendChild(wrapper);
        return bubble;
    }

    function scrollToBottom() {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    // Message sending & streaming API
    async function handleMessageSubmit() {
        const text = userInput.value.trim();
        if (!text || isGenerating) return;

        if (!isDbConnected) {
            alert('Database is not connected. Message cannot be processed.');
            return;
        }

        // Close sidebar on mobile
        if (window.innerWidth <= 768) {
            sidebar.classList.remove('open');
        }

        // Create new chat session if none active
        if (!currentChatId) {
            const id = Date.now().toString();
            const newChat = {
                id: id,
                title: text.substring(0, 30) + (text.length > 30 ? '...' : ''),
                model: modelSelect.value
            };
            
            try {
                const res = await fetch('/api/chats', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(newChat)
                });
                
                if (!res.ok) throw new Error('Database initialization failed');
                
                chats.unshift(newChat);
                currentChatId = id;
                renderChatHistory();
            } catch (e) {
                console.error(e);
                alert('Database write failed. Unable to start chat.');
                return;
            }
        }

        const chat = chats.find(c => c.id === currentChatId);
        if (!chat) return;

        // Update local state title if it's the first message
        const isFirstMessage = !chat.messages || chat.messages.length === 0;
        if (isFirstMessage) {
            chat.title = text.substring(0, 30) + (text.length > 30 ? '...' : '');
            currentChatTitle.innerText = chat.title;
            chat.messages = [];
        }

        // Append user message to UI
        appendMessage('user', text);
        chat.messages.push({ role: 'user', content: text });

        // Clear input and reset height
        userInput.value = '';
        adjustTextareaHeight();
        toggleSendButton();
        scrollToBottom();

        // Add assistant typing bubble
        isGenerating = true;
        sendBtn.disabled = true;
        
        const botBubble = appendMessage('bot', '');
        const indicator = document.createElement('div');
        indicator.className = 'typing-indicator';
        indicator.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
        botBubble.appendChild(indicator);
        scrollToBottom();

        let botReply = '';
        
        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: currentChatId,
                    message: { role: 'user', content: text },
                    model: chat.model
                })
            });

            if (!response.ok) {
                throw new Error(`Server returned ${response.status}: ${response.statusText}`);
            }

            // Remove indicator
            botBubble.innerHTML = '';
            
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let done = false;

            while (!done) {
                const { value, done: readerDone } = await reader.read();
                done = readerDone;
                if (value) {
                    const chunk = decoder.decode(value, { stream: !done });
                    botReply += chunk;
                    botBubble.innerHTML = parseMarkdown(botReply);
                    scrollToBottom();
                }
            }

            // Save assistant response locally
            chat.messages.push({ role: 'assistant', content: botReply });
            
            // Trigger refresh of list in background to ensure sync and update sidebar title
            if (isFirstMessage) {
                await fetchChatsFromDB();
                renderChatHistory();
            }

        } catch (error) {
            console.error('Error fetching stream:', error);
            botBubble.innerHTML = `<span style="color: #ef4444; font-weight: 600;">⚠️ Error:</span> Unable to stream response. Details: ${error.message}`;
        } finally {
            isGenerating = false;
            sendBtn.disabled = false;
            toggleSendButton();
            scrollToBottom();
        }
    }

    // Markdown & Formatting utilities
    function parseMarkdown(markdown) {
        if (!markdown) return '';
        
        const lines = markdown.split('\n');
        let html = '';
        let inCodeBlock = false;
        let codeContent = '';
        let codeLanguage = '';
        let inList = false;
        let listType = ''; // 'ul' or 'ol'
        
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            
            // Code Blocks ```
            if (line.trim().startsWith('```')) {
                if (inCodeBlock) {
                    html += `<pre><div class="code-header"><span>${codeLanguage || 'code'}</span><button class="copy-code-btn" onclick="copyCode(this)">Copy</button></div><code>${escapeHtml(codeContent.trim())}</code></pre>`;
                    inCodeBlock = false;
                    codeContent = '';
                    codeLanguage = '';
                } else {
                    inCodeBlock = true;
                    codeLanguage = line.trim().substring(3).trim();
                }
                continue;
            }
            
            if (inCodeBlock) {
                codeContent += line + '\n';
                continue;
            }
            
            // Lists
            const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)/);
            const olMatch = line.match(/^(\s*)\d+\.\s+(.*)/);
            
            if (ulMatch) {
                if (!inList || listType !== 'ul') {
                    if (inList) html += `</${listType}>`;
                    html += '<ul>';
                    inList = true;
                    listType = 'ul';
                }
                html += `<li>${parseInlineMarkdown(ulMatch[2])}</li>`;
                continue;
            } else if (olMatch) {
                if (!inList || listType !== 'ol') {
                    if (inList) html += `</${listType}>`;
                    html += '<ol>';
                    inList = true;
                    listType = 'ol';
                }
                html += `<li>${parseInlineMarkdown(olMatch[2])}</li>`;
                continue;
            } else {
                if (inList) {
                    html += `</${listType}>`;
                    inList = false;
                    listType = '';
                }
            }
            
            // Headings
            const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
            if (headingMatch) {
                const level = headingMatch[1].length;
                html += `<h${level}>${parseInlineMarkdown(headingMatch[2])}</h${level}>`;
                continue;
            }
            
            // Blockquotes
            if (line.trim().startsWith('>')) {
                const quoteContent = line.replace(/^\s*>\s*/, '');
                html += `<blockquote>${parseInlineMarkdown(quoteContent)}</blockquote>`;
                continue;
            }
            
            // Paragraphs and breaks
            if (line.trim() === '') {
                html += '<br>';
            } else {
                html += `<p>${parseInlineMarkdown(line)}</p>`;
            }
        }
        
        // Clean up open lists or code blocks
        if (inCodeBlock) {
            html += `<pre><div class="code-header"><span>${codeLanguage || 'code'}</span><button class="copy-code-btn" onclick="copyCode(this)">Copy</button></div><code>${escapeHtml(codeContent.trim())}</code></pre>`;
        }
        if (inList) {
            html += `</${listType}>`;
        }
        
        return html.replace(/<p><br><\/p>/g, '<br>').replace(/<p><\/p>/g, '');
    }

    function escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function parseInlineMarkdown(text) {
        let escaped = escapeHtml(text);
        
        // Bold **text**
        escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        
        // Italic *text* or _text_
        escaped = escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        escaped = escaped.replace(/_([^_]+)_/g, '<em>$1</em>');
        
        // Inline code `code`
        escaped = escaped.replace(/`([^`\n]+)`/g, '<code>$1</code>');
        
        return escaped;
    }

    // Global copy code utility
    window.copyCode = function(button) {
        const code = button.parentElement.nextElementSibling.innerText;
        navigator.clipboard.writeText(code).then(() => {
            button.innerText = 'Copied!';
            button.style.backgroundColor = 'rgba(34, 197, 94, 0.2)';
            button.style.borderColor = 'rgba(34, 197, 94, 0.4)';
            button.style.color = '#22c55e';
            
            setTimeout(() => {
                button.innerText = 'Copy';
                button.style.backgroundColor = '';
                button.style.borderColor = '';
                button.style.color = '';
            }, 2000);
        }).catch(err => {
            console.error('Failed to copy code block:', err);
        });
    };
});
