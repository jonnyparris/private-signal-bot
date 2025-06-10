package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Example message received from signal-cli
// {
//   "envelope": {
//     "source": "+12025550123",
//     "sourceNumber": "+12025550123",
//     "sourceUuid": "a1b2c3d4-5678-90ab-cdef-1234567890ab",
//     "sourceName": "Alex",
//     "sourceDevice": 1,
//     "timestamp": 1749577203637,
//     "serverReceivedTimestamp": 1749577201848,
//     "serverDeliveredTimestamp": 1749577201850,
//     "syncMessage": {
//       "sentMessage": {
//         "destination": "+12025550123",
//         "destinationNumber": "+12025550123",
//         "destinationUuid": "a1b2c3d4-5678-90ab-cdef-1234567890ab",
//         "timestamp": 1749577203637,
//         "message": "Hello there",
//         "expiresInSeconds": 0,
//         "viewOnce": false
//       }
//     }
//   },
//   "account": "+12025550123"
// }

type Message struct {
	Envelope struct {
		Source      string `json:"source"`
		SyncMessage struct {
			SentMessage struct {
				Message string `json:"message"`
			} `json:"sentMessage"`
		} `json:"syncMessage"`
		DataMessage struct {
			Message string `json:"message"`
		} `json:"dataMessage"`
	} `json:"envelope"`
}

func getEnv(key, fallback string) string {
	if val, exists := os.LookupEnv(key); exists {
		return val
	}
	return fallback
}

func receiveMessages() ([]Message, error) {
	cmd := exec.Command("signal-cli", "--output=json", "receive")
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, err
	}

	var messages []Message
	scanner := bufio.NewScanner(&out)
	for scanner.Scan() {
		var msg Message
		if err := json.Unmarshal(scanner.Bytes(), &msg); err == nil {
			messages = append(messages, msg)
		}
	}
	return messages, nil
}

func sendReply(recipient, text string) {
	exec.Command("signal-cli", "send", "-m", text, recipient).Run()
}

func callAgent(agentURL, prompt string) (string, error) {
	payload := map[string]string{"prompt": prompt}
	body, _ := json.Marshal(payload)

	if agentURL == "" {
		return "", fmt.Errorf("agent URL is not set")
	}
	if !strings.HasPrefix(agentURL, "http://") && !strings.HasPrefix(agentURL, "https://") {
		return "", fmt.Errorf("invalid agent URL: %s", agentURL)
	}
	if !strings.HasSuffix(agentURL, "/") {
		agentURL += "/"
	}

	resp, err := http.Post(agentURL+"signal-bot", "application/json", bytes.NewBuffer(body))
	if err != nil {
		fmt.Printf("Error calling agent: %s\n", err)
		return "", err
	}
	defer resp.Body.Close()

	var response map[string]string
	json.NewDecoder(resp.Body).Decode(&response)
	return response["response"], nil
}

func main() {
	aiPrefix := getEnv("AI_PREFIX", "!ai")
	agentURL := getEnv("AGENT_URL", "")

	for {
		msgs, err := receiveMessages()
		if err != nil {
			fmt.Println("Error receiving messages:", err)
			time.Sleep(10 * time.Second)
			continue
		}

		for _, msg := range msgs {
			content := msg.Envelope.SyncMessage.SentMessage.Message
			if content == "" {
				content = msg.Envelope.DataMessage.Message
			}
			if strings.HasPrefix(content, "!ai ") {
				prompt := strings.TrimPrefix(content, "!ai ")
				reply, err := callAgent(agentURL, prompt)
				if err != nil {
					reply = "Error: " + err.Error()
				}
				sendReply(msg.Envelope.Source, reply)
			} else if strings.HasPrefix(content, "!code ") {
				prompt := "Respond with only code. " + strings.TrimPrefix(content, "!code ")
				reply, err := callAgent(agentURL, prompt)
				if err != nil {
					reply = "Error: " + err.Error()
				}
				sendReply(msg.Envelope.Source, reply)
			} else if strings.HasPrefix(content, "!img ") {
				sendReply(msg.Envelope.Source, "Image generation is not yet supported.")
			} else if strings.HasPrefix(content, "!weather ") {
				sendReply(msg.Envelope.Source, "Weather feature coming soon, maybe.")
				prompt := strings.TrimPrefix(content, aiPrefix)
				fmt.Printf("AI prompt from %s: %s\n", msg.Envelope.Source, prompt)
				reply, err := callAgent(agentURL, prompt)
				if err != nil {
					reply = "Sorry, I had an error: " + err.Error()
				}
				sendReply(msg.Envelope.Source, reply)
			}
		}
		time.Sleep(5 * time.Second)
	}
}
