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

type Message struct {
	Envelope struct {
		Source      string `json:"source"`
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

func receiveMessages(signalNumber string) ([]Message, error) {
	cmd := exec.Command("signal-cli", "-u", signalNumber, "receive", "-t", "json")
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

func sendReply(signalNumber, recipient, text string) {
	exec.Command("signal-cli", "-u", signalNumber, "send", "-m", text, recipient).Run()
}

func callAgent(agentURL, prompt string) (string, error) {
	payload := map[string]string{"prompt": prompt}
	body, _ := json.Marshal(payload)
	resp, err := http.Post(agentURL, "application/json", bytes.NewBuffer(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var response map[string]string
	json.NewDecoder(resp.Body).Decode(&response)
	return response["response"], nil
}

func main() {
	signalNumber := getEnv("SIGNAL_NUMBER", "")
	aiPrefix := getEnv("AI_PREFIX", "!ai")
	agentURL := getEnv("AGENT_URL", "")

	for {
		msgs, err := receiveMessages(signalNumber)
		if err != nil {
			fmt.Println("Error receiving messages:", err)
			time.Sleep(10 * time.Second)
			continue
		}

		for _, msg := range msgs {
			content := msg.Envelope.DataMessage.Message
			if strings.HasPrefix(content, "!ai ") {
				prompt := strings.TrimPrefix(content, "!ai ")
				reply, err := callAgent(agentURL, prompt)
				if err != nil {
					reply = "Error: " + err.Error()
				}
				sendReply(signalNumber, msg.Envelope.Source, reply)
			} else if strings.HasPrefix(content, "!code ") {
				prompt := "Respond with only code. " + strings.TrimPrefix(content, "!code ")
				reply, err := callAgent(agentURL, prompt)
				if err != nil {
					reply = "Error: " + err.Error()
				}
				sendReply(signalNumber, msg.Envelope.Source, reply)
			} else if strings.HasPrefix(content, "!img ") {
				sendReply(signalNumber, msg.Envelope.Source, "Image generation is not yet supported.")
			} else if strings.HasPrefix(content, "!weather ") {
				sendReply(signalNumber, msg.Envelope.Source, "Weather feature coming soon.")
				prompt := strings.TrimPrefix(content, aiPrefix)
				fmt.Printf("AI prompt from %s: %s\n", msg.Envelope.Source, prompt)
				reply, err := callAgent(agentURL, prompt)
				if err != nil {
					reply = "Sorry, I had an error: " + err.Error()
				}
				sendReply(signalNumber, msg.Envelope.Source, reply)
			}
		}
		time.Sleep(5 * time.Second)
	}
}
