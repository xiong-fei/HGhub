import { useEffect, useRef, useState } from "react";
import { exit } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { api, fmtTime } from "../api";
import { ISearch } from "../icons";
import type { Detail, VideoCard } from "../types";
import VideoSurface, { type VideoHandle } from "./VideoSurface";

const COLLAPSED = { w: 160, h: 16 };
const DEFAULT_EXPANDED = { w: 280, h: 498 };
const STORAGE_KEY = "hghub_moyu_current";
const SIZE_KEY = "hghub_moyu_size";

type Current = { id: number; ep: number };
type Size = { w: number; h: number };

function readExpandedSize(): Size {
  try {
    const raw = localStorage.getItem(SIZE_KEY);
    if (!raw) return DEFAULT_EXPANDED;
    const value = JSON.parse(raw) as Partial<Size>;
    if (typeof value.w === "number" && typeof value.h === "number" && value.w > 120 && value.h > 80) {
      return { w: Math.round(value.w), h: Math.round(value.h) };
    }
  } catch {
    /* 使用默认尺寸 */
  }
  return DEFAULT_EXPANDED;
}

function readCurrent(): Current | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Current>;
    return typeof value.id === "number" && typeof value.ep === "number"
      ? { id: value.id, ep: value.ep }
      : null;
  } catch {
    return null;
  }
}

async function placeInitial(win: ReturnType<typeof getCurrentWindow>) {
  let left = Math.max(0, window.screen.availWidth - COLLAPSED.w - 18);
  let top = Math.max(0, window.screen.availHeight - COLLAPSED.h - 18);
  try {
    const monitor = await currentMonitor();
    if (monitor) {
      const scale = monitor.scaleFactor;
      left = (monitor.workArea.position.x + monitor.workArea.size.width) / scale - COLLAPSED.w - 18;
      top = (monitor.workArea.position.y + monitor.workArea.size.height) / scale - COLLAPSED.h - 18;
    }
  } catch {
    /* 使用 screen 兜底 */
  }
  try {
    await win.setPosition(new LogicalPosition(left, top));
    await win.setSize(new LogicalSize(COLLAPSED.w, COLLAPSED.h));
  } catch {
    /* 窗口 API 不可用时保持当前位置 */
  }
  return { x: left, y: top };
}

/** 摸鱼迷你窗：收起是一条小透明条；悬停展开播放，移出收起并暂停。 */
export default function MoyuMini() {
  const win = useRef(getCurrentWindow()).current;
  const video = useRef<VideoHandle>(null);
  const lastTimeRef = useRef(0);
  const rightArmed = useRef(0);
  const arrowRightDown = useRef(false);
  const expandTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const resizing = useRef(false);
  const dragging = useRef(false);
  const holdOpen = useRef(false);
  const collapsing = useRef(false);
  const fixingSize = useRef(false);
  const barDragging = useRef(false);
  const collapsedPos = useRef<{ x: number; y: number } | null>(null);
  const barDrag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [expandedSize, setExpandedSize] = useState<Size>(readExpandedSize);
  const expandedSizeRef = useRef(expandedSize);
  const expandedRef = useRef(false);
  const [current, setCurrent] = useState<Current | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [src, setSrc] = useState("");
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(0.8);
  const [showVolume, setShowVolume] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VideoCard[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [alpha, setAlpha] = useState(() => {
    const saved = Number(localStorage.getItem("hghub_moyu_alpha"));
    return Number.isFinite(saved) && saved > 0 ? saved : 0.8;
  });

  useEffect(() => {
    expandedSizeRef.current = expandedSize;
  }, [expandedSize]);

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    document.documentElement.classList.add("moyu-root");
    void win.setAlwaysOnTop(true);
    void placeInitial(win).then((pos) => { collapsedPos.current = pos; });
    const syncCurrent = () => {
      const next = readCurrent();
      setCurrent((prev) =>
        !prev || !next || (prev.id === next.id && prev.ep === next.ep) ? prev : next,
      );
    };
    const syncTimer = window.setInterval(syncCurrent, 1000);
    let unlistenResize: (() => void) | undefined;
    let unlistenMove: (() => void) | undefined;
    const clampToScreen = async () => {
      try {
        const monitor = await currentMonitor();
        if (!monitor) return;
        const pos = await win.outerPosition();
        const size = await win.outerSize();
        const scale = monitor.scaleFactor;
        if (barDragging.current && !expandedRef.current && size.height < 80) {
          collapsedPos.current = { x: pos.x / scale, y: pos.y / scale };
        }
        if (expandedRef.current && !fixingSize.current && (size.width / scale < 220 || size.height / scale < 160)) {
          fixingSize.current = true;
          await win.setSize(new LogicalSize(Math.max(220, size.width / scale), Math.max(160, size.height / scale)));
          fixingSize.current = false;
        }
        if (expandedRef.current && size.height > 80) {
          const next = { w: Math.round(size.width / scale), h: Math.round(size.height / scale) };
          if (next.w > 120 && next.h > 80) {
            expandedSizeRef.current = next;
            setExpandedSize(next);
            localStorage.setItem(SIZE_KEY, JSON.stringify(next));
          }
          if (dragging.current && !resizing.current) {
            collapsedPos.current = {
              x: pos.x / scale,
              y: (pos.y + size.height) / scale - COLLAPSED.h,
            };
          }
        }
        const area = monitor.workArea;
        const x = Math.max(area.position.x, Math.min(pos.x, area.position.x + area.size.width - size.width));
        const y = Math.max(area.position.y, Math.min(pos.y, area.position.y + area.size.height - size.height));
        if (x !== pos.x || y !== pos.y) {
          await win.setPosition(new LogicalPosition(x / scale, y / scale));
        }
      } catch { /* ignore */ }
    };
    void win.onResized(() => void clampToScreen()).then((fn) => { unlistenResize = fn; });
    void win.onMoved(() => void clampToScreen()).then((fn) => { unlistenMove = fn; });
    return () => {
      window.clearInterval(syncTimer);
      unlistenResize?.();
      unlistenMove?.();
      if (expandTimer.current) window.clearTimeout(expandTimer.current);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [win]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") arrowRightDown.current = true;
      if ((e.key === "0" || e.code === "Numpad0") && (arrowRightDown.current || Date.now() < rightArmed.current)) {
        e.preventDefault();
        void exit(0);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") arrowRightDown.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      let target = current;
      if (!target) {
        try {
          const feed = await api.feed(1, 1);
          const first = feed?.items?.[0];
          if (first) {
            target = { id: first.id, ep: 1 };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(target));
            if (alive) setCurrent(target);
          }
        } catch {
          return;
        }
      }
      if (!target) return;
      try {
        const nextDetail = await api.video(target.id);
        if (alive) setDetail(nextDetail);
      } catch {
        /* 详情失败仍可播放 */
      }
      try {
        const info = await api.play(target.id, target.ep);
        const url = info?.streams?.main || info?.video_url;
        if (alive && url) {
          invoke("debug_log", { msg: `[moyu] load id=${target.id} ep=${target.ep}` }).catch(() => {});
          setSrc(url);
        }
      } catch {
        /* 保持收起，不打断主界面 */
      }
    };
    void load();
    return () => { alive = false; };
  }, [current]);

  const changeEp = (delta: number) => {
    if (!current || !detail) return;
    const next = detail.episodes.find((e) => e.ep_num === current.ep + delta);
    if (next) {
      const value = { id: current.id, ep: next.ep_num };
      // 和主界面的当前剧集记录保持一致，避免轮询把集数切回去
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      setTime(0);
      setDuration(0);
      setCurrent(value);
    }
  };

  const setMiniSize = async (expandedNext: boolean) => {
    const pos = await win.outerPosition();
    let scale = 1;
    try {
      const monitor = await currentMonitor();
      scale = monitor?.scaleFactor ?? 1;
    } catch { /* ignore */ }
    const target = expandedNext ? expandedSizeRef.current : COLLAPSED;
    const targetH = Math.max(160, target.h);
    const delta = targetH - COLLAPSED.h;
    const current = { x: pos.x / scale, y: pos.y / scale };
    const anchor = collapsedPos.current ?? current;
    if (expandedNext) {
      collapsedPos.current = current;
      await win.setSize(new LogicalSize(Math.max(220, target.w), targetH));
      await win.setPosition(new LogicalPosition(anchor.x, anchor.y - delta));
    } else {
      collapsing.current = true;
      await win.setSize(new LogicalSize(COLLAPSED.w, COLLAPSED.h));
      await win.setPosition(new LogicalPosition(anchor.x, anchor.y));
      window.setTimeout(() => { collapsing.current = false; }, 300);
    }
  };

  const expandNow = () => {
    if (expanded) return;
    setExpanded(true);
    void setMiniSize(true);
    window.setTimeout(() => video.current?.play(), 100);
  };

  const scheduleExpand = () => {
    if (expanded) return;
    if (expandTimer.current) window.clearTimeout(expandTimer.current);
    expandTimer.current = window.setTimeout(expandNow, 180);
  };

  const scheduleCollapse = () => {
    if (expandTimer.current) window.clearTimeout(expandTimer.current);
    if (!expanded || resizing.current || dragging.current || holdOpen.current) return;
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (resizing.current || dragging.current) return;
      video.current?.pause();
      setExpanded(false);
      void setMiniSize(false);
    }, 260);
  };

  const collapseNow = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    video.current?.pause();
    setExpanded(false);
    void setMiniSize(false);
  };

  const startDrag = () => {
    dragging.current = true;
    resizing.current = false;
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    window.setTimeout(() => { dragging.current = false; }, 4000);
    void win.startDragging().finally(() => {
      window.setTimeout(() => { dragging.current = false; }, 200);
    });
  };

  const startResize = (direction: "SouthEast" | "NorthEast") => {
    resizing.current = true;
    dragging.current = false;
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    window.setTimeout(() => { resizing.current = false; }, 4000);
    void win.startResizeDragging(direction).finally(() => {
      window.setTimeout(() => { resizing.current = false; }, 800);
    });
  };

  const runSearch = async () => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setSearchError("");
    try {
      const res = await api.search(q, 1, 20);
      setResults(res?.items || []);
    } catch (e) {
      setResults([]);
      setSearchError((e as Error).message || "搜索失败");
    } finally {
      setSearching(false);
    }
  };

  const chooseVideo = (item: VideoCard) => {
    const next = { id: item.id, ep: 1 };
    // 同步写回主界面使用的当前剧集，避免 1 秒轮询又切回旧剧
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSearchOpen(false);
    setTime(0);
    setDuration(0);
    setCurrent(next);
  };

  const onBarPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (expanded) return;
    barDragging.current = true;
    barDrag.current = { x: e.clientX, y: e.clientY, moved: false };
  };

  const onBarPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = barDrag.current;
    if (!d || d.moved) return;
    if (Math.abs(e.clientX - d.x) > 4 || Math.abs(e.clientY - d.y) > 4) {
      d.moved = true;
      dragging.current = true;
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      void win.startDragging().finally(() => {
        window.setTimeout(() => { dragging.current = false; }, 250);
      });
    }
  };

  const onBarPointerUp = () => {
    const d = barDrag.current;
    barDrag.current = null;
    if (d && !d.moved) expandNow();
    window.setTimeout(() => {
      dragging.current = false;
      barDragging.current = false;
    }, 100);
  };

  return (
    <div
      className={`moyu-shell ${expanded ? "is-open" : ""}`}
      style={{ opacity: alpha }}
      onPointerEnter={scheduleExpand}
      onPointerLeave={() => {
        setShowControls(false);
        if (holdOpen.current) {
          window.setTimeout(() => {
            holdOpen.current = false;
            resizing.current = false;
            dragging.current = false;
            scheduleCollapse();
          }, 700);
        } else {
          resizing.current = false;
          dragging.current = false;
          scheduleCollapse();
        }
      }}
      onPointerUp={() => {
        window.setTimeout(() => {
          resizing.current = false;
          dragging.current = false;
        }, 120);
      }}
      onPointerCancel={() => {
        resizing.current = false;
        dragging.current = false;
      }}
      onMouseEnter={scheduleExpand}
      onMouseLeave={scheduleCollapse}
      onPointerMove={(e) => {
        if (!expanded) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const nearBottomRight = e.clientX >= rect.right - 64 && e.clientY >= rect.bottom - 64;
        const nearTopRight = e.clientX >= rect.right - 64 && e.clientY <= rect.top + 64;
        const nearResize = nearBottomRight || nearTopRight;
        holdOpen.current = nearResize;
        setShowControls(e.clientY - rect.top >= rect.height - 52 || searchOpen || showVolume);
        if (nearResize && hideTimer.current) window.clearTimeout(hideTimer.current);
      }}
      onWheel={(e) => {
        e.preventDefault();
        const next = Math.max(0.15, Math.min(1, alpha - e.deltaY * 0.001));
        setAlpha(next);
        localStorage.setItem("hghub_moyu_alpha", String(next));
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        rightArmed.current = Date.now() + 1200;
      }}
    >
      {src && (
        <div className={`moyu-stage ${expanded ? "" : "is-collapsed"}`}>
          <VideoSurface
            ref={video}
            src={src}
            autoPlay
            active={expanded}
            muted={muted}
            volume={volume}
            fit="contain"
            className="moyu-video"
            onTime={(t) => {
              if (lastTimeRef.current > 1.5 && t < 0.5) {
                invoke("debug_log", { msg: `[moyu] time reset ${lastTimeRef.current.toFixed(1)} -> ${t.toFixed(1)}` }).catch(() => {});
              }
              lastTimeRef.current = t;
              setTime(t);
            }}
            onDuration={setDuration}
            onPlaying={() => setPaused(false)}
            onPause={() => setPaused(true)}
            onError={(m) => invoke("debug_log", { msg: `[moyu] video error ${m}` }).catch(() => {})}
          />
        </div>
      )}
      {(!expanded || !src) && (
        <div
          className="moyu-handle"
          title="拖动小条可移动，单击展开"
          onPointerDown={onBarPointerDown}
          onPointerMove={onBarPointerMove}
          onPointerUp={onBarPointerUp}
          onPointerCancel={() => { barDrag.current = null; }}
        >
          <div
            className="moyu-grip"
            data-tauri-drag-region
            title="按住拖动小条"
            onPointerDown={() => {
              barDragging.current = true;
              window.setTimeout(() => { barDragging.current = false; }, 4000);
            }}
            onPointerUp={() => {
              window.setTimeout(() => { barDragging.current = false; }, 200);
            }}
            onPointerEnter={() => {
              if (expandTimer.current) window.clearTimeout(expandTimer.current);
            }}
          />
        </div>
      )}
      {expanded && (
        <>
          <div className="moyu-drag" onPointerDown={startDrag} />
          <div className="moyu-meta">
            <div className="moyu-title">{detail?.title || "正在播放"}</div>
            <div className="moyu-ep">
              第 {current?.ep ?? 1} 集
              {detail?.episodes.find((e) => e.ep_num === current?.ep)?.title
                ? ` · ${detail.episodes.find((e) => e.ep_num === current?.ep)?.title}`
                : ""}
            </div>
          </div>
          {searchOpen && (
            <div className="moyu-search">
              <form
                className="moyu-search-bar"
                onSubmit={(e) => {
                  e.preventDefault();
                  void runSearch();
                }}
              >
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索剧名、作者、题材"
                />
                <button type="submit" aria-label="搜索">{searching ? "…" : "搜"}</button>
                <button type="button" aria-label="关闭搜索" onClick={() => setSearchOpen(false)}>✕</button>
              </form>
              <div className="moyu-search-list">
                {searchError ? (
                  <div className="moyu-search-empty">{searchError}</div>
                ) : searching ? (
                  <div className="moyu-search-empty">搜索中…</div>
                ) : results.length ? (
                  results.map((item) => (
                    <button key={item.id} type="button" className="moyu-result" onClick={() => chooseVideo(item)}>
                      <span className="moyu-result-title">{item.title}</span>
                      <span className="moyu-result-meta">
                        {item.episode_count ? `${item.episode_count} 集` : ""}
                        {item.tags?.length ? ` · ${item.tags.slice(0, 2).join(" / ")}` : ""}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="moyu-search-empty">输入关键词后搜索</div>
                )}
              </div>
            </div>
          )}
          <div className={`moyu-controls ${showControls ? "is-visible" : ""}`}>
            <button type="button" aria-label="收起" title="收起为小条" onClick={collapseNow}>▾</button>
            <button type="button" aria-label={paused ? "播放" : "暂停"} onClick={() => video.current?.toggle()}>
              {paused ? "▶" : "⏸"}
            </button>
            <button type="button" onClick={() => changeEp(-1)} disabled={!detail?.episodes.some((e) => e.ep_num === (current?.ep ?? 1) - 1)}>
              上一集
            </button>
            <input
              type="range"
              aria-label="播放进度"
              min={0}
              max={duration || 1}
              step={0.1}
              value={Math.min(time, duration || 0)}
              onChange={(e) => {
                const next = Number(e.target.value);
                video.current?.seek(next, "moyu");
                setTime(next);
              }}
            />
            <span className="moyu-time">{fmtTime(time)}/{fmtTime(duration)}</span>
            <button type="button" onClick={() => changeEp(1)} disabled={!detail?.episodes.some((e) => e.ep_num === (current?.ep ?? 1) + 1)}>
              下一集
            </button>
            <button
              type="button"
              aria-label={muted ? "取消静音" : "静音"}
              onClick={() => setShowVolume((v) => !v)}
            >
              {muted || volume === 0 ? "🔇" : "🔊"}
            </button>
            <button type="button" aria-label="搜索其他剧" title="搜索其他剧" onClick={() => setSearchOpen((v) => !v)}>
              <ISearch size={14} />
            </button>
            <button type="button" aria-label="退出" title="退出（也可右键 + 0）" onClick={() => void exit(0)}>
              ✕
            </button>
          </div>
          {showVolume && (
            <div className="moyu-volume-pop">
              <button
                type="button"
                aria-label={muted ? "取消静音" : "静音"}
                onClick={() => {
                  const next = !muted;
                  setMuted(next);
                  video.current?.mute(next);
                }}
              >
                {muted || volume === 0 ? "🔇" : "🔊"}
              </button>
              <input
                type="range"
                aria-label="音量"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setVolume(next);
                  setMuted(next === 0);
                  video.current?.volume(next);
                  video.current?.mute(next === 0);
                }}
              />
            </div>
          )}
          <div
            className="moyu-resize"
            title="拖动调整大小"
            onPointerDown={() => startResize("SouthEast")}
            onPointerEnter={() => {
              holdOpen.current = true;
              if (hideTimer.current) window.clearTimeout(hideTimer.current);
            }}
            onPointerLeave={() => { holdOpen.current = false; }}
          />
          <div
            className="moyu-resize-tr"
            title="拖动调整大小"
            onPointerDown={() => startResize("NorthEast")}
            onPointerEnter={() => {
              holdOpen.current = true;
              if (hideTimer.current) window.clearTimeout(hideTimer.current);
            }}
            onPointerLeave={() => { holdOpen.current = false; }}
          />
        </>
      )}
    </div>
  );
}
