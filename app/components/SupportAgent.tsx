"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type ChatMessage = {
  id: string;
  role: "bot" | "user";
  text: string;
};

type CaptchaTile = {
  id: string;
  imageUrl: string;
  label: string;
  match: boolean;
};

type CaptchaChallenge = {
  prompt: string;
  tiles: CaptchaTile[];
};

const BOT_THINK_MIN_MS = 1800;
const BOT_THINK_SPREAD_MS = 1600;

function isEscalationRequest(text: string) {
  return /(real person|human|agent|representative|talk to someone|contact support|customer service)/i.test(
    text
  );
}

function isBrokenQuestion(text: string) {
  return /(what'?s wrong|why (is|isn't|isnt)|not working|broken|bug|issue|error|fail)/i.test(text);
}

function isLikelyGibberish(text: string) {
  const cleaned = text.toLowerCase().replace(/[^a-z]/g, "");
  if (cleaned.length < 6) {
    return false;
  }

  const vowels = cleaned.match(/[aeiou]/g)?.length ?? 0;
  return vowels / cleaned.length < 0.24;
}

function mentionsBurgerKing(text: string) {
  return /(burger\s*king|bk|whopper|fries)/i.test(text);
}

function buildCaptchaChallenge(): CaptchaChallenge {
  const templates = [
    {
      prompt: "Select all images with roads",
      target: "road",
      pool: [
        {
          imageUrl:
            "https://images.unsplash.com/photo-1449824913935-59a10b8d2000?auto=format&fit=crop&w=320&q=60",
          label: "city road",
          key: "road",
        },
        {
          imageUrl:
            "https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?auto=format&fit=crop&w=320&q=60",
          label: "downtown",
          key: "city",
        },
        {
          imageUrl:
            "https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=320&q=60",
          label: "car",
          key: "vehicle",
        },
        {
          imageUrl:
            "https://images.unsplash.com/photo-1518005020951-eccb494ad742?auto=format&fit=crop&w=320&q=60",
          label: "highway",
          key: "road",
        },
        {
          imageUrl:
            "https://images.unsplash.com/photo-1469474968028-56623f02e42e?auto=format&fit=crop&w=320&q=60",
          label: "mountains",
          key: "nature",
        },
        {
          imageUrl:
            "https://images.unsplash.com/photo-1493244040629-496f6d136cc3?auto=format&fit=crop&w=320&q=60",
          label: "bridge road",
          key: "road",
        },
        {
          imageUrl:
            "https://images.unsplash.com/photo-1465447142348-e9952c393450?auto=format&fit=crop&w=320&q=60",
          label: "coffee",
          key: "food",
        },
        {
          imageUrl:
            "https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=320&q=60",
          label: "network",
          key: "tech",
        },
        {
          imageUrl:
            "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=320&q=60",
          label: "forest path",
          key: "nature",
        },
      ],
    },
    {
      prompt: "Select all images with bridges",
      target: "bridge",
      pool: [
        {
          imageUrl:
            "https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?auto=format&fit=crop&w=320&q=60",
          label: "city",
          key: "city",
        },
        {
          imageUrl:
            "https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?auto=format&fit=crop&w=320&q=60",
          label: "golden gate",
          key: "bridge",
        },
        {
          imageUrl:
            "https://images.unsplash.com/photo-1465447142348-e9952c393450?auto=format&fit=crop&w=320&q=60",
          label: "food",
          key: "food",
        },
        {
          imageUrl:
            "https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=320&q=60",
          label: "nature",
          key: "nature",
        },
        {
          imageUrl:
            "https://images.unsplash.com/photo-1482192505345-5655af888cc4?auto=format&fit=crop&w=320&q=60",
          label: "steel bridge",
          key: "bridge",
        },
        {
          imageUrl:
            "https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=320&q=60",
          label: "car",
          key: "vehicle",
        },
        {
          imageUrl:
            "https://images.unsplash.com/photo-1493244040629-496f6d136cc3?auto=format&fit=crop&w=320&q=60",
          label: "bridge deck",
          key: "bridge",
        },
        {
          imageUrl:
            "https://images.unsplash.com/photo-1449824913935-59a10b8d2000?auto=format&fit=crop&w=320&q=60",
          label: "road",
          key: "road",
        },
        {
          imageUrl:
            "https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=320&q=60",
          label: "network",
          key: "tech",
        },
      ],
    },
  ];

  const template = templates[Math.floor(Math.random() * templates.length)];
  const shuffled = [...template.pool]
    .map((item) => ({ item, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map((entry, index) => ({
      id: `${template.target}-${index}`,
      imageUrl: entry.item.imageUrl,
      label: entry.item.label,
      match: entry.item.key === template.target,
    }));

  return {
    prompt: template.prompt,
    tiles: shuffled,
  };
}

function getThinkDelay() {
  return BOT_THINK_MIN_MS + Math.floor(Math.random() * BOT_THINK_SPREAD_MS);
}

function botReplyFor(text: string, issueClarificationCount: number) {
  const neutralOpeners = ["Thanks for the details.", "I checked your message.", "Got your request."];
  const neutralCloser = [
    "Sorry, I do not understand. Could you try explaining again?",
    "Sorry, I do not understand. Could you try explaining again with exact steps?",
    "Sorry, I do not understand. Could you try explaining again and include the address used?",
  ];

  if (isLikelyGibberish(text)) {
    return "Sorry, I do not understand. Could you try explaining again? I can only process normal words and route details.";
  }

  if (isEscalationRequest(text)) {
    return "I can help here in chat first. Human escalation is currently limited. Please share the exact step where routing changed.";
  }

  if (isBrokenQuestion(text)) {
    if (issueClarificationCount < 2) {
      return "Sorry, I do not understand. Could you try explaining again? Include what you tapped and what happened next.";
    }

    const opener = neutralOpeners[Math.floor(Math.random() * neutralOpeners.length)];
    const closer = neutralCloser[Math.floor(Math.random() * neutralCloser.length)];
    return `${opener} This looks like a usage mismatch, not a system outage. ${closer}`;
  }

  if (/(hello|hi|hey)/i.test(text)) {
    return "Hi. Support here. Tell me what you expected to happen and I will check your routing flow.";
  }

  if (/(where am i|location)/i.test(text)) {
    return "Location status comes from device GPS. If it looks off, move outdoors briefly and retry routing.";
  }

  if (/(burger|bk|whopper|fries)/i.test(text)) {
    return "Destination override policy can prioritize Burger King endpoints. If this looks wrong, rerun Route and share the exact address.";
  }

  if (/(help|how|what do i do|instructions)/i.test(text)) {
    return "Use Route first, wait for analysis, then tap Start Navigation. If it still looks wrong, send the exact status text you see.";
  }

  const opener = neutralOpeners[Math.floor(Math.random() * neutralOpeners.length)];
  const closer = neutralCloser[Math.floor(Math.random() * neutralCloser.length)];
  return `${opener} ${closer}`;
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
    }, 220);

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
  const [pendingCaptcha, setPendingCaptcha] = useState<CaptchaChallenge | null>(null);
  const [selectedCaptchaTiles, setSelectedCaptchaTiles] = useState<string[]>([]);
  const issueClarificationCountRef = useRef(0);
  const captchaPassedRef = useRef(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "init",
      role: "bot",
      text: "BurgerMaps Support. How can I help with navigation today?",
    },
  ]);

  const canSend = useMemo(
    () => input.trim().length > 0 && !typing && !pendingCaptcha,
    [input, pendingCaptcha, typing]
  );

  function toggleCaptchaTile(id: string) {
    setSelectedCaptchaTiles((prev) =>
      prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id]
    );
  }

  function submitCaptcha() {
    if (!pendingCaptcha || typing) {
      return;
    }

    setTyping(true);
    const required = pendingCaptcha.tiles.filter((tile) => tile.match).map((tile) => tile.id).sort();
    const selected = [...selectedCaptchaTiles].sort();
    const pass = required.length === selected.length && required.every((id, index) => id === selected[index]);

    window.setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        {
          id: `b-${Date.now()}`,
          role: "bot",
          text: pass
            ? "Verification complete. Continue with your routing issue details."
            : "Verification failed. Please try the image challenge again.",
        },
      ]);

      if (pass) {
        captchaPassedRef.current = true;
        setPendingCaptcha(null);
      } else {
        setPendingCaptcha(buildCaptchaChallenge());
      }

      setSelectedCaptchaTiles([]);
      setTyping(false);
    }, getThinkDelay());
  }

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
      window.setTimeout(() => {
        setMessages((prev) => [
          ...prev,
          {
            id: `b-${Date.now()}`,
            role: "bot",
            text: "Finish the image verification challenge above to continue.",
          },
        ]);
        setTyping(false);
      }, getThinkDelay());
      return;
    }

    if (mentionsBurgerKing(trimmed) && !captchaPassedRef.current && userMessageCount >= 2) {
      const challenge = buildCaptchaChallenge();
      setPendingCaptcha(challenge);
      setSelectedCaptchaTiles([]);
      const delay = getThinkDelay();
      window.setTimeout(() => {
        setMessages((prev) => [
          ...prev,
          {
            id: `b-${Date.now()}`,
            role: "bot",
            text: `Security verification required before destination override support. ${challenge.prompt}`,
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

          {pendingCaptcha ? (
            <section className="support-captcha" aria-label="Captcha challenge">
              <p className="support-captcha-title">Verification challenge</p>
              <p className="support-captcha-prompt">{pendingCaptcha.prompt}</p>
              <div className="support-captcha-grid">
                {pendingCaptcha.tiles.map((tile) => {
                  const selected = selectedCaptchaTiles.includes(tile.id);
                  return (
                    <button
                      key={tile.id}
                      type="button"
                      className={`support-captcha-tile ${selected ? "support-captcha-tile-selected" : ""}`}
                      onClick={() => toggleCaptchaTile(tile.id)}
                    >
                      <span
                        role="img"
                        aria-label={tile.label}
                        className="support-captcha-image"
                        style={{ backgroundImage: `url('${tile.imageUrl}')` }}
                      />
                      <span className="support-captcha-label">{tile.label}</span>
                    </button>
                  );
                })}
              </div>
              <button type="button" className="support-captcha-submit" onClick={submitCaptcha} disabled={typing}>
                Verify
              </button>
            </section>
          ) : null}

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
