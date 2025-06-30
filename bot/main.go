package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Config holds the bot configuration
type Config struct {
	AIPrefix string
	AgentURL string
}

// Message represents a Signal message structure
type Message struct {
	Envelope struct {
		Source         string `json:"source"`
		Timestamp      int64  `json:"timestamp"`
		IsReceipt      bool   `json:"isReceipt"`
		SyncMessage    struct {
			SentMessage struct {
				Destination     string `json:"destination"`
				DestinationUuid string `json:"destinationUuid"`
				Message         string `json:"message"`
				Timestamp       int64  `json:"timestamp"`
				GroupInfo       struct {
					GroupId   string `json:"groupId"`
					GroupName string `json:"groupName"`
				} `json:"groupInfo"`
			} `json:"sentMessage"`
		} `json:"syncMessage"`
		DataMessage struct {
			Message   string `json:"message"`
			Timestamp int64  `json:"timestamp"`
			GroupInfo struct {
				GroupId   string `json:"groupId"`
				GroupName string `json:"groupName"`
			} `json:"groupInfo"`
		} `json:"dataMessage"`
		ReceiptMessage struct {
			When        int64   `json:"when"`
			IsDelivery  bool    `json:"isDelivery"`
			IsRead      bool    `json:"isRead"`
			Timestamps  []int64 `json:"timestamps"`
		} `json:"receiptMessage"`
	} `json:"envelope"`
}

// PendingMessage stores a sent AI message waiting for delivery confirmation
type PendingMessage struct {
	Timestamp int64
	Content   string
	Prompt    string
	SentTime  time.Time
}

// AgentRequest represents the request payload to the agent
type AgentRequest struct {
	Prompt string `json:"prompt"`
}

// AgentResponse represents the response from the agent
type AgentResponse struct {
	Response string `json:"response"`
}

// SignalBot handles Signal message processing
type SignalBot struct {
	config          Config
	logger          *log.Logger
	triggers        []string
	pendingMessages map[int64]*PendingMessage // timestamp -> pending message
}

// NewSignalBot creates a new SignalBot instance
func NewSignalBot() *SignalBot {
	config := Config{
		AIPrefix: getEnv("AI_PREFIX", "!ai"),
		AgentURL: getEnv("AGENT_URL", ""),
	}

	logger := log.New(os.Stdout, "[SignalBot] ", log.LstdFlags)

	return &SignalBot{
		config:          config,
		logger:          logger,
		triggers:        []string{"🤖 ", "qq ", config.AIPrefix + " "},
		pendingMessages: make(map[int64]*PendingMessage),
	}
}

// getEnv returns environment variable value or fallback
func getEnv(key, fallback string) string {
	if val, exists := os.LookupEnv(key); exists {
		return val
	}
	return fallback
}

// validateConfig checks if the bot configuration is valid
func (bot *SignalBot) validateConfig() error {
	if bot.config.AgentURL == "" {
		return fmt.Errorf("AGENT_URL environment variable is required")
	}

	if !strings.HasPrefix(bot.config.AgentURL, "http://") &&
		!strings.HasPrefix(bot.config.AgentURL, "https://") {
		return fmt.Errorf("invalid agent URL: %s (must start with http:// or https://)", bot.config.AgentURL)
	}

	return nil
}

// receiveMessages fetches messages from signal-cli
func (bot *SignalBot) receiveMessages() ([]Message, error) {
	cmd := exec.Command("signal-cli", "--output=json", "receive", "--ignore-attachments", "--ignore-stories")
	var out bytes.Buffer
	cmd.Stdout = &out

	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("failed to execute signal-cli: %w", err)
	}

	var messages []Message
	scanner := bufio.NewScanner(&out)

	for scanner.Scan() {
		var msg Message
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			bot.logger.Printf("Error unmarshaling JSON: %v", err)
			continue
		}
		messages = append(messages, msg)
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("error reading signal-cli output: %w", err)
	}

	return messages, nil
}

// sendReply sends a reply message via signal-cli with italic formatting using --text-style
func (bot *SignalBot) sendReply(recipient, text string, quoteMsgId int64, quoteAuthor string) error {
	var args []string

	// Handle group vs individual messages differently
	if strings.HasPrefix(recipient, "-g ") {
		// Group message: extract group ID and use proper syntax
		groupId := strings.TrimPrefix(recipient, "-g ")
		args = []string{"send", "-g", groupId, "-m", text, "--text-style", "0:" + strconv.Itoa(len(text)) + ":ITALIC"}

		// Add quote parameters for groups
		if quoteMsgId > 0 && quoteAuthor != "" {
			args = append(args, "--quote-timestamp", strconv.FormatInt(quoteMsgId, 10))
			args = append(args, "--quote-author", quoteAuthor)
		}
	} else {
		// Individual message: recipient MUST be the last argument
		args = []string{"send", "-m", text, "--text-style", "0:" + strconv.Itoa(len(text)) + ":ITALIC"}

		// Add quote parameters BEFORE the recipient
		if quoteMsgId > 0 && quoteAuthor != "" {
			args = append(args, "--quote-timestamp", strconv.FormatInt(quoteMsgId, 10))
			args = append(args, "--quote-author", quoteAuthor)
		}

		// Recipient must be the final argument for individual messages
		args = append(args, recipient)
	}

	bot.logger.Printf("Executing: signal-cli %s", strings.Join(args, " "))

	cmd := exec.Command("signal-cli", args...)

	// Capture both stdout and stderr for better debugging
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		bot.logger.Printf("Command failed - stdout: %s, stderr: %s", stdout.String(), stderr.String())
		return fmt.Errorf("failed to send reply to %s: %w (stderr: %s)", recipient, err, stderr.String())
	}

	return nil
}

// callAgent makes a request to the AI agent
func (bot *SignalBot) callAgent(ctx context.Context, prompt string) (string, error) {
	request := AgentRequest{Prompt: prompt}
	body, err := json.Marshal(request)
	if err != nil {
		return "", fmt.Errorf("failed to marshal request: %w", err)
	}

	url := strings.TrimSuffix(bot.config.AgentURL, "/") + "/signal-bot"

	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewBuffer(body))
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to call agent: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("agent returned status %d", resp.StatusCode)
	}

	var response AgentResponse
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return "", fmt.Errorf("failed to decode response: %w", err)
	}

	return response.Response, nil
}

// extractContent extracts message content from either sync or data message
func (msg *Message) extractContent() string {
	if content := msg.Envelope.SyncMessage.SentMessage.Message; content != "" {
		return content
	}
	return msg.Envelope.DataMessage.Message
}

// extractTimestamp extracts message timestamp from either sync or data message
func (msg *Message) extractTimestamp() int64 {
	if timestamp := msg.Envelope.SyncMessage.SentMessage.Timestamp; timestamp != 0 {
		return timestamp
	}
	if timestamp := msg.Envelope.DataMessage.Timestamp; timestamp != 0 {
		return timestamp
	}
	return msg.Envelope.Timestamp
}

// extractGroupId extracts group ID from either sync or data message
func (msg *Message) extractGroupId() string {
	if groupId := msg.Envelope.SyncMessage.SentMessage.GroupInfo.GroupId; groupId != "" {
		return groupId
	}
	return msg.Envelope.DataMessage.GroupInfo.GroupId
}

// getRecipient determines the recipient for data messages (messages you received)
func (msg *Message) getRecipient() string {
	// For data messages (messages you RECEIVED), reply in the same context
	if msg.Envelope.DataMessage.Message != "" {
		// Check if it was a group message
		if groupId := msg.Envelope.DataMessage.GroupInfo.GroupId; groupId != "" {
			return "-g " + groupId
		}
		// For individual messages you received, reply to the sender
		if msg.Envelope.Source != "" {
			return msg.Envelope.Source
		}
	}
	return ""
}

// isTriggered checks if the message should trigger the bot (case-insensitive for "qq")
func (bot *SignalBot) isTriggered(content string) bool {
	for _, trigger := range bot.triggers {
		if trigger == "qq " {
			// Case-insensitive check for "qq " trigger
			if len(content) >= 3 && strings.ToLower(content[:3]) == "qq " {
				return true
			}
		} else {
			// Case-sensitive check for other triggers
			if strings.HasPrefix(content, trigger) {
				return true
			}
		}
	}
	return false
}

// extractPrompt removes the trigger prefix from the message content (case-insensitive for "qq")
func (bot *SignalBot) extractPrompt(content string) string {
	for _, trigger := range bot.triggers {
		if trigger == "qq " {
			// Case-insensitive check for "qq " trigger
			if len(content) >= 3 && strings.ToLower(content[:3]) == "qq " {
				return strings.TrimSpace(content[3:])
			}
		} else {
			// Case-sensitive check for other triggers
			if strings.HasPrefix(content, trigger) {
				return strings.TrimSpace(strings.TrimPrefix(content, trigger))
			}
		}
	}
	return content
}

// cleanupOldPendingMessages removes pending messages older than 5 minutes
func (bot *SignalBot) cleanupOldPendingMessages() {
	cutoff := time.Now().Add(-5 * time.Minute)
	for timestamp, pending := range bot.pendingMessages {
		if pending.SentTime.Before(cutoff) {
			delete(bot.pendingMessages, timestamp)
		}
	}
}

// processMessage handles a single message
func (bot *SignalBot) processMessage(ctx context.Context, msg Message) {
	// Handle delivery receipts first - these tell us where a sent message was delivered
	if msg.Envelope.ReceiptMessage.IsDelivery && len(msg.Envelope.ReceiptMessage.Timestamps) > 0 {
		bot.logger.Printf("Received delivery receipt from %s", msg.Envelope.Source)

		// Check if any of the timestamps match our pending AI-triggered messages
		for _, timestamp := range msg.Envelope.ReceiptMessage.Timestamps {
			if pending, exists := bot.pendingMessages[timestamp]; exists {
				bot.logger.Printf("Found pending AI message for timestamp %d, processing...", timestamp)

				// Now we know where to send the reply - to the person who confirmed delivery
				recipient := msg.Envelope.Source

				// Call the AI agent with the original prompt
				reply, err := bot.callAgent(ctx, pending.Prompt)
				if err != nil {
					bot.logger.Printf("Error calling agent for pending message: %v", err)
					reply = "Sorry, I encountered an error processing your request."
				}

				// Send the reply to the person who received the original message
				if err := bot.sendReply(recipient, reply, timestamp, msg.Envelope.Source); err != nil {
					bot.logger.Printf("Error sending reply for pending message: %v", err)
				} else {
					bot.logger.Printf("Successfully sent AI reply to %s for pending message", recipient)
				}

				// Remove from pending messages
				delete(bot.pendingMessages, timestamp)
				return
			}
		}
		return
	}

	// Handle regular messages
	content := msg.extractContent()
	if content == "" {
		return
	}

	if !bot.isTriggered(content) {
		return
	}

	prompt := bot.extractPrompt(content)
	if prompt == "" {
		bot.logger.Printf("Empty prompt after removing trigger prefix")
		return
	}

	// Handle sync messages (your own sent messages with AI triggers)
	if msg.Envelope.SyncMessage.SentMessage.Message != "" {
		timestamp := msg.extractTimestamp()

		// Check if this was sent to a group (we can reply immediately)
		if groupId := msg.extractGroupId(); groupId != "" {
			bot.logger.Printf("Processing AI-triggered group message")

			reply, err := bot.callAgent(ctx, prompt)
			if err != nil {
				bot.logger.Printf("Error calling agent: %v", err)
				reply = "Sorry, I encountered an error processing your request."
			}

			recipient := "-g " + groupId
			quoteAuthor := msg.Envelope.Source

			if err := bot.sendReply(recipient, reply, timestamp, quoteAuthor); err != nil {
				bot.logger.Printf("Error sending reply: %v", err)
			} else {
				bot.logger.Printf("Successfully sent AI reply to group")
			}
			return
		}

		// For individual DMs, store as pending and wait for delivery receipt
		bot.logger.Printf("Storing AI-triggered DM message as pending (timestamp: %d)", timestamp)
		bot.pendingMessages[timestamp] = &PendingMessage{
			Timestamp: timestamp,
			Content:   content,
			Prompt:    prompt,
			SentTime:  time.Now(),
		}
		return
	}

	// Handle data messages (messages you received)
	if msg.Envelope.DataMessage.Message != "" {
		recipient := msg.getRecipient()
		if recipient == "" {
			bot.logger.Printf("No recipient found for received message")
			return
		}

		bot.logger.Printf("Processing AI-triggered received message from %s", msg.Envelope.Source)

		reply, err := bot.callAgent(ctx, prompt)
		if err != nil {
			bot.logger.Printf("Error calling agent: %v", err)
			reply = "Sorry, I encountered an error processing your request."
		}

		timestamp := msg.extractTimestamp()
		quoteAuthor := msg.Envelope.Source

		if err := bot.sendReply(recipient, reply, timestamp, quoteAuthor); err != nil {
			bot.logger.Printf("Error sending reply: %v", err)
		} else {
			bot.logger.Printf("Successfully sent AI reply to %s", recipient)
		}
	}
}

// Run starts the bot's main processing loop
func (bot *SignalBot) Run(ctx context.Context) error {
	if err := bot.validateConfig(); err != nil {
		return fmt.Errorf("configuration error: %w", err)
	}

	bot.logger.Printf("Starting Signal bot with triggers: %v", bot.triggers)
	bot.logger.Printf("Agent URL: %s", bot.config.AgentURL)

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	// Cleanup ticker for old pending messages
	cleanupTicker := time.NewTicker(1 * time.Minute)
	defer cleanupTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			bot.logger.Printf("Shutting down bot...")
			return ctx.Err()
		case <-cleanupTicker.C:
			bot.cleanupOldPendingMessages()
		case <-ticker.C:
			messages, err := bot.receiveMessages()
			if err != nil {
				bot.logger.Printf("Error receiving messages: %v", err)
				continue
			}

			if len(messages) == 0 {
				continue
			}

			bot.logger.Printf("Received %d messages", len(messages))

			for _, msg := range messages {
				select {
				case <-ctx.Done():
					return ctx.Err()
				default:
					bot.processMessage(ctx, msg)
				}
			}

			// Brief pause between message processing
			time.Sleep(1 * time.Second)
		}
	}
}

func main() {
	bot := NewSignalBot()

	// Setup graceful shutdown
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-sigChan
		log.Println("Received shutdown signal")
		cancel()
	}()

	if err := bot.Run(ctx); err != nil && err != context.Canceled {
		log.Fatalf("Bot error: %v", err)
	}
}