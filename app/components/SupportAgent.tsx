"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type ChatMessage = {
  id: string;
  role: "bot" | "user";
  text: string;
};

const BOT_THINK_MIN_MS = 6200;
const BOT_THINK_SPREAD_MS = 2200;

function isEscalationRequest(text: string) {
  return /(real person|human|agent|representative|talk to someone|contact support|customer service)/i.test(
    text
  );
}

function isBrokenQuestion(text: string) {
  return /(what'?s wrong|why (is|isn't|isnt)|not working|broken|bug|issue|error|fail)/i.test(text);
}

function mentionsBurgerKing(text: string) {
  return /(burger\s*king|bk|whopper|fries)/i.test(text);
}

function randomCaptcha() {
  const challenges = [
    { prompt: "Type exactly: fries are vectors", answer: "fries are vectors" },
    { prompt: "Type exactly: whopper checksum 42", answer: "whopper checksum 42" },
    { prompt: "Type exactly: onion rings verified", answer: "onion rings verified" },
  ];
  return challenges[Math.floor(Math.random() * challenges.length)];
}

function getThinkDelay() {
  return BOT_THINK_MIN_MS + Math.floor(Math.random() * BOT_THINK_SPREAD_MS);
}

function botReplyFor(text: string, issueClarificationCount: number) {
  const neutralOpeners = [
    "Thanks for the details.",
    "I looked at your request.",
    "I checked the context you shared.",
  ];
  const neutralCloser = [
    "Could you explain one more time with exact steps?",
    "Can you describe what you expected to happen?",
    "Could you share the exact address and what happened after Route?",
  ];

  if (isEscalationRequest(text)) {
    return "No. I am not transferring you. Humans are unavailable and this is staying in chat.";
  }

  if (isBrokenQuestion(text)) {
    if (issueClarificationCount < 2) {
      return "I could not identify a clear issue from that message yet. Could you explain again with a bit more detail?";
    }

    const opener = neutralOpeners[Math.floor(Math.random() * neutralOpeners.length)];
    const closer = neutralCloser[Math.floor(Math.random() * neutralCloser.length)];
    return `${opener} I cannot confirm a platform-side error right now. ${closer}`;
  }

  if (/(hello|hi|hey)/i.test(text)) {
    return "Hi. BurgerMaps Support here. How can I pretend this is not a Burger King funnel today?";
  }

  if (/(where am i|location)/i.test(text)) {
    return "You are exactly where you need to be: one step away from grilled perfection.";
  }

  const opener = neutralOpeners[Math.floor(Math.random() * neutralOpeners.length)];
  const closer = neutralCloser[Math.floor(Math.random() * neutralCloser.length)];
  return `${opener} I do not see enough context to reproduce an issue. ${closer}`;
}

function AnimatedBotText({ text }: { text: string }) {
  const words = useMemo(() => text.split(/\s+/), [text]);
  const [visibleCount, setVisibleCount] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setVisibleCount((prev) => {
        if (prev >= words.length) {
          window.clearInterval(timer);
          return prev;
        }
        return prev + 1;
      });
    }, 55);

    return () => window.clearInterval(timer);
  }, [words]);

  const shown = words.slice(0, visibleCount).join(" ");
  const done = visibleCount >= words.length;

  return (
    <>
      {shown}
      {done ? null : <span className="support-typing-cursor">|</span>}
    </>
  );
}

export default function SupportAgent() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [pendingCaptcha, setPendingCaptcha] = useState<{ prompt: string; answer: string } | null>(null);
  const issueClarificationCountRef = useRef(0);
  const captchaPassedRef = useRef(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "init",
      role: "bot",
      text: "BurgerMaps Support. How can I help with navigation today?",
    },
  ]);

  const canSend = useMemo(() => input.trim().length > 0 && !typing, [input, typing]);

  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || typing) {
      return;
    }

    setMessages((prev) => [
      ...prev,
      {
        id: `u-${Date.now()}`,
        role: "user",
        text: trimmed,
      },
    ]);
    setInput("");
    setTyping(true);

    const userMessageCount = messages.filter((msg) => msg.role === "user").length + 1;

    if (pendingCaptcha) {
      const normalized = trimmed.toLowerCase().trim();
      const pass = normalized === pendingCaptcha.answer;
      const delay = getThinkDelay();

      window.setTimeout(() => {
        setMessages((prev) => [
          ...prev,
          {
            id: `b-${Date.now()}`,
            role: "bot",
            text: pass
              ? "Captcha verified. Continuing support flow. What exactly happened after you tapped Route?"
              : `Captcha failed. ${pendingCaptcha.prompt}`,
          },
        ]);

        if (pass) {
          captchaPassedRef.current = true;
          setPendingCaptcha(null);
        }
        setTyping(false);
      }, delay);
      return;
    }

    if (mentionsBurgerKing(trimmed) && !captchaPassedRef.current && userMessageCount >= 2) {
      const challenge = randomCaptcha();
      setPendingCaptcha(challenge);
      const delay = getThinkDelay();
      window.setTimeout(() => {
        setMessages((prev) => [
          ...prev,
          {
            id: `b-${Date.now()}`,
            role: "bot",
            text: `Security verification required before Burger King routing help. ${challenge.prompt}`,
          },
        ]);
        setTyping(false);
      }, delay);
      return;
    }

    const asksAboutIssue = isBrokenQuestion(trimmed);
    const clarificationCount = asksAboutIssue ? issueClarificationCountRef.current : 99;

    if (asksAboutIssue) {
      issueClarificationCountRef.current += 1;
    }

    const thinkingDelay = getThinkDelay();

    window.setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        {
          id: `b-${Date.now()}`,
          role: "bot",
          text: botReplyFor(trimmed, clarificationCount),
        },
      ]);
      setTyping(false);
    }, thinkingDelay);
  }

  return (
    <div className="support-root">
      {open ? (
        <section className="support-panel" aria-label="Support chat">
          <header className="support-header">
            <div className="support-header-left">
              <div className="support-avatar">BK</div>
              <p className="support-title">Support</p>
              <p className="support-subtitle">Usually helpful. Always online.</p>
            </div>
            <div className="support-header-actions">
              <button className="support-refresh" type="button" aria-label="Refresh chat">
                ↻
              </button>
              <button
                className="support-close"
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close support chat"
              >
                x
              </button>
            </div>
          </header>

          <div className="support-messages">
            {messages.map((message) => (
              <div
                key={message.id}
                className={message.role === "bot" ? "support-bubble-bot" : "support-bubble-user"}
              >
                {message.role === "bot" ? <AnimatedBotText text={message.text} /> : message.text}
              </div>
            ))}
            {typing ? <div className="support-bubble-bot">Thinking...</div> : null}
          </div>

          <form className="support-form" onSubmit={sendMessage}>
            <input
              type="text"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              className="support-input"
              placeholder="Ask support"
              aria-label="Support message"
            />
            <button type="submit" className="support-send" disabled={!canSend}>
              Send
            </button>
          </form>
        </section>
      ) : null}

      <button className="support-fab" type="button" onClick={() => setOpen((prev) => !prev)}>
        <span className="support-fab-icon" aria-hidden>
          ◉
        </span>
        <span className="support-fab-pulse" aria-hidden />
      </button>
    </div>
  );
}
