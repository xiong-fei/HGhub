import { useEffect, useRef, useState } from "react";
import { exit } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { api, cover, fmtTime } from "../api";
import { ISearch } from "../icons";
import type { Detail, RankItem, VideoCard } from "../types";
import VideoSurface, { type VideoHandle } from "./VideoSurface";

const COLLAPSED = { w: 160, h: 16 };
const DEFAULT_EXPANDED = { w: 280, h: 498 };
const STORAGE_KEY = "hghub_moyu_current";
const SIZE_KEY = "hghub_moyu_size";
const FEED_IDS_KEY = "hghub_moyu_feed_ids";

type Current = { id: number; ep: number };
type Size = { w: number; h: number };
type RecommendTab = "recommend" | "hot" | "similar";
type RecommendItem = {
  id: number;
  title: string;
  cover: string;
  tags?: string[];
  episode_count?: number;
  is_finished?: boolean;
  description?: string;
  score?: number;
  metric_value?: number;
};

const RECOMMEND_TABS: { key: RecommendTab; label: string }[] = [
  { key: "recommend", label: "精选" },
  { key: "hot", label: "热门" },
  { key: "similar", label: "同类" },
];

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

function readFeedIds(): number[] {
  try {
    const value = JSON.parse(localStorage.getItem(FEED_IDS_KEY) || "[]") as unknown;
    return Array.isArray(value)
      ? [...new Set(value.filter((id): id is number => typeof id === "number" && Number.isFinite(id) && id > 0))]
      : [];
  } catch {
    return [];
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
    await win.setMinSize(new LogicalSize(COLLAPSED.w, COLLAPSED.h));
    await win.setPosition(new LogicalPosition(left, top));
    await win.setSize(new LogicalSize(COLLAPSED.w, COLLAPSED.h));
  } catch {
    /* 窗口 API 不可用时保持当前位置 */
  }
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
  const holdTimer = useRef<number | undefined>(undefined);
  const hovered = useRef(false);
  const resizing = useRef(false);
  const dragging = useRef(false);
  const holdOpen = useRef(false);
  const panelOpen = useRef(false);
  const collapsing = useRef(false);
  const collapseGuardTimer = useRef<number | undefined>(undefined);
  const barDragging = useRef(false);
  const barDrag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [expandedSize, setExpandedSize] = useState<Size>(readExpandedSize);
  const expandedSizeRef = useRef(expandedSize);
  const expandedRef = useRef(false);
  const sizeIntent = useRef(0);
  const sizeQueue = useRef<Promise<void>>(Promise.resolve());
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
  const [recommendOpen, setRecommendOpen] = useState(false);
  const [recommendTab, setRecommendTab] = useState<RecommendTab>("recommend");
  const [recommendItems, setRecommendItems] = useState<RecommendItem[]>([]);
  const [recommendBatch, setRecommendBatch] = useState(0);
  const [recommendLoading, setRecommendLoading] = useState(false);
  const [recommendError, setRecommendError] = useState("");
  const [recommendHint, setRecommendHint] = useState("");
  const [luckyItem, setLuckyItem] = useState<RecommendItem | null>(null);
  const recommendRequest = useRef(0);
  const browseFeed = useRef<{ ids: number[]; page: number; pages: number }>({ ids: [], page: 0, pages: 1 });
  const videoIntent = useRef(0);
  const switchingVideo = useRef(false);
  const [videoSwitching, setVideoSwitching] = useState(false);
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<number | undefined>(undefined);
  const nextPressTimer = useRef<number | undefined>(undefined);
  const nextLongPressed = useRef(false);
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
    sizeQueue.current = sizeQueue.current.catch(() => {}).then(() => placeInitial(win));
    void sizeQueue.current.catch(() => {});
    const syncCurrent = () => {
      const next = readCurrent();
      setCurrent((prev) =>
        !prev || !next || (prev.id === next.id && prev.ep === next.ep) ? prev : next,
      );
    };
    const syncTimer = window.setInterval(syncCurrent, 1000);
    let unlistenResize: (() => void) | undefined;
    let unlistenMove: (() => void) | undefined;
    let unlistenPrimaryUp: (() => void) | undefined;
    const clampToScreen = async () => {
      try {
        const monitor = await currentMonitor();
        if (!monitor) return;
        const pos = await win.outerPosition();
        const size = await win.outerSize();
        const scale = monitor.scaleFactor;
        if (expandedRef.current && size.height > 80) {
          const next = { w: Math.round(size.width / scale), h: Math.round(size.height / scale) };
          const prev = expandedSizeRef.current;
          if (next.w > 120 && next.h > 80 && (next.w !== prev.w || next.h !== prev.h)) {
            expandedSizeRef.current = next;
            setExpandedSize(next);
            localStorage.setItem(SIZE_KEY, JSON.stringify(next));
          }
        }
        // 原生拖动/缩放和程序展开/收起期间只读状态，禁止反向 setPosition 形成位移反馈。
        if (resizing.current || dragging.current || barDragging.current || collapsing.current) return;
        const area = monitor.workArea;
        const x = Math.max(area.position.x, Math.min(pos.x, area.position.x + area.size.width - size.width));
        const y = Math.max(area.position.y, Math.min(pos.y, area.position.y + area.size.height - size.height));
        if (x !== pos.x || y !== pos.y) {
          await win.setPosition(new LogicalPosition(x / scale, y / scale));
        }
      } catch { /* ignore */ }
    };
    const finishNativeGesture = () => {
      resizing.current = false;
      dragging.current = false;
      barDragging.current = false;
      barDrag.current = null;
      holdOpen.current = false;
      if (holdTimer.current) window.clearTimeout(holdTimer.current);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      holdTimer.current = undefined;
      hideTimer.current = undefined;
      void clampToScreen().then(() => {
        if (!hovered.current) scheduleCollapse();
      });
    };
    void win.onResized(() => void clampToScreen()).then((fn) => { unlistenResize = fn; });
    void win.onMoved(() => void clampToScreen()).then((fn) => { unlistenMove = fn; });
    void listen("moyu-primary-up", finishNativeGesture).then((fn) => { unlistenPrimaryUp = fn; });
    return () => {
      window.clearInterval(syncTimer);
      unlistenResize?.();
      unlistenMove?.();
      unlistenPrimaryUp?.();
      if (expandTimer.current) window.clearTimeout(expandTimer.current);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      if (holdTimer.current) window.clearTimeout(holdTimer.current);
      if (collapseGuardTimer.current) window.clearTimeout(collapseGuardTimer.current);
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
      if (nextPressTimer.current) window.clearTimeout(nextPressTimer.current);
      videoIntent.current += 1;
      recommendRequest.current += 1;
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
    const onBlur = () => {
      // 松开方向键时窗口可能已失焦，避免之后单按 0 被误判为退出组合键。
      arrowRightDown.current = false;
      rightArmed.current = 0;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
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
            // setCurrent 会重新执行本 effect，避免启动时重复请求详情和播放地址。
            return;
          }
        } catch {
          return;
        }
      }
      if (!target) return;
      // 切剧/切集期间以及新地址获取失败时，都不能继续播放上一集。
      setSrc("");
      setDetail(null);
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
        /* 已清空旧源，保持收起，不打断主界面 */
      }
    };
    void load();
    return () => { alive = false; };
  }, [current]);

  const loadRecommend = async (tab: RecommendTab) => {
    const request = ++recommendRequest.current;
    setRecommendLoading(true);
    setRecommendError("");
    setRecommendHint("");
    setRecommendItems([]);
    setRecommendBatch(0);
    setLuckyItem(null);
    try {
      let items: RecommendItem[] = [];
      let hint = "";
      if (tab === "similar") {
        let source = detail?.id === current?.id ? detail : null;
        if (!source && current) source = await api.video(current.id);
        if (request !== recommendRequest.current) return;
        const tag = source?.tags?.[0] || "";
        const author = source?.author?.name || "";
        const keyword = tag || author;
        if (keyword) {
          let res = await api.search(keyword, 1, 30);
          if (request !== recommendRequest.current) return;
          let found = (res?.items || []).filter((item) => item.id !== current?.id);
          if (!found.length && author && author !== keyword) {
            res = await api.search(author, 1, 30);
            if (request !== recommendRequest.current) return;
            found = (res?.items || []).filter((item) => item.id !== current?.id);
          }
          items = found.map((item) => ({
            id: item.id,
            title: item.title,
            cover: item.cover,
            tags: item.tags,
            episode_count: item.episode_count,
            is_finished: item.is_finished,
            description: item.description,
            score: item.score,
          }));
          hint = source?.title ? `因为你在看《${source.title}》` : `同类题材 · ${keyword}`;
        } else {
          hint = "当前剧集暂无题材信息";
        }
      } else {
        const res = await api.rank(tab);
        if (request !== recommendRequest.current) return;
        items = (res?.items || []).map((item: RankItem) => ({
          id: item.video_id,
          title: item.title,
          cover: item.cover,
          tags: item.tags,
          episode_count: item.episode_count,
          is_finished: item.is_finished,
          score: item.score,
          metric_value: item.metric_value,
        }));
        hint = tab === "hot" ? "大家都在看" : "编辑精选，换一批看看";
      }
      setRecommendItems(items);
      setRecommendHint(hint);
    } catch (error) {
      if (request === recommendRequest.current) {
        setRecommendError((error as Error).message || "推荐加载失败");
      }
    } finally {
      if (request === recommendRequest.current) setRecommendLoading(false);
    }
  };

  useEffect(() => {
    if (recommendOpen) void loadRecommend(recommendTab);
    // 同类推荐跟随当前剧；精选和热门只在打开或切换标签时加载。
  }, [recommendOpen, recommendTab, current?.id]);

  const changeEp = (delta: number) => {
    if (!current || !detail) return;
    const next = detail.episodes.find((e) => e.ep_num === current.ep + delta);
    if (next) {
      videoIntent.current += 1;
      const value = { id: current.id, ep: next.ep_num };
      // 和主界面的当前剧集记录保持一致，避免轮询把集数切回去
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      setTime(0);
      setDuration(0);
      setCurrent(value);
    }
  };

  const setMiniSize = async (expandedNext: boolean, intent: number) => {
    if (collapseGuardTimer.current) window.clearTimeout(collapseGuardTimer.current);
    collapsing.current = true;
    const currentIntent = () => intent === sizeIntent.current;
    try {
      const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
      if (!currentIntent()) return;
      let scale = 1;
      try {
        const monitor = await currentMonitor();
        scale = monitor?.scaleFactor ?? 1;
      } catch { /* ignore */ }
      if (!currentIntent()) return;
      const current = { x: pos.x / scale, y: pos.y / scale };
      // 展开和收起都使用当前实际窗口位置，避免拖动事件结束后仍引用旧锚点。
      const anchor = expandedNext
        ? current
        : { x: current.x, y: current.y + size.height / scale - COLLAPSED.h };
      const target = expandedNext ? expandedSizeRef.current : COLLAPSED;
      const targetW = expandedNext ? Math.max(220, target.w) : COLLAPSED.w;
      const targetH = expandedNext ? Math.max(160, target.h) : COLLAPSED.h;
      const targetPos = expandedNext
        ? { x: anchor.x, y: anchor.y - (targetH - COLLAPSED.h) }
        : anchor;
      await win.setMinSize(new LogicalSize(
        expandedNext ? 220 : COLLAPSED.w,
        expandedNext ? 160 : COLLAPSED.h,
      ));
      if (!currentIntent()) return;
      await win.setSize(new LogicalSize(targetW, targetH));
      if (!currentIntent()) return;
      await win.setPosition(new LogicalPosition(targetPos.x, targetPos.y));
      if (!currentIntent()) return;

      // 原生尺寸事件可能晚于 Promise 返回；读取实际尺寸，失败时补一次最终写入。
      const actual = await win.outerSize();
      if (!currentIntent()) return;
      if (Math.abs(actual.width / scale - targetW) > 2 || Math.abs(actual.height / scale - targetH) > 2) {
        await win.setSize(new LogicalSize(targetW, targetH));
        if (!currentIntent()) return;
        await win.setPosition(new LogicalPosition(targetPos.x, targetPos.y));
      }
    } finally {
      if (currentIntent()) {
        // 等待本次尺寸和位置事件全部送达，再恢复屏幕边界纠正。
        collapseGuardTimer.current = window.setTimeout(() => { collapsing.current = false; }, 300);
      }
    }
  };

  const queueMiniSize = (expandedNext: boolean) => {
    // 只执行最新意图；旧的展开任务不能在鼠标移出后覆盖收起尺寸。
    const intent = ++sizeIntent.current;
    sizeQueue.current = sizeQueue.current.catch(() => {}).then(async () => {
      if (intent === sizeIntent.current) await setMiniSize(expandedNext, intent);
    });
    void sizeQueue.current.catch((error) => {
      invoke("debug_log", { msg: `[moyu] geometry ${expandedNext ? "expand" : "collapse"} ${String(error)}` }).catch(() => {});
    });
  };

  const expandNow = () => {
    expandTimer.current = undefined;
    if (expandedRef.current) return;
    // 同步记录意图，避免 React 重渲染前鼠标已经移出时漏掉收起。
    expandedRef.current = true;
    setExpanded(true);
    queueMiniSize(true);
    window.setTimeout(() => video.current?.play(), 100);
  };

  const scheduleExpand = () => {
    hovered.current = true;
    // 即使已经展开，也要取消上一次移出留下的收起任务。
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    hideTimer.current = undefined;
    holdTimer.current = undefined;
    if (expandedRef.current) return;
    if (expandTimer.current) window.clearTimeout(expandTimer.current);
    expandTimer.current = window.setTimeout(expandNow, 180);
  };

  const scheduleCollapse = () => {
    if (expandTimer.current) window.clearTimeout(expandTimer.current);
    if (!expandedRef.current || resizing.current || dragging.current || holdOpen.current || panelOpen.current) return;
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (hovered.current || !expandedRef.current || resizing.current || dragging.current || holdOpen.current || panelOpen.current) return;
      video.current?.pause();
      expandedRef.current = false;
      setExpanded(false);
      queueMiniSize(false);
    }, 260);
  };

  const collapseNow = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    video.current?.pause();
    expandedRef.current = false;
    setExpanded(false);
    queueMiniSize(false);
  };

  const startDrag = () => {
    dragging.current = true;
    resizing.current = false;
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    void win.startDragging().catch(() => {
      dragging.current = false;
      if (!hovered.current) scheduleCollapse();
    });
  };

  const startResize = (direction: "SouthEast" | "NorthEast") => {
    resizing.current = true;
    dragging.current = false;
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    void win.startResizeDragging(direction).catch(() => {
      resizing.current = false;
      if (!hovered.current) scheduleCollapse();
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

  const showNotice = (message: string) => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = undefined;
      setNotice("");
    }, 1600);
  };

  const selectVideo = (id: number) => {
    videoIntent.current += 1;
    const next = { id, ep: 1 };
    // 同步写回主界面使用的当前剧集，避免 1 秒轮询又切回旧剧
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSearchOpen(false);
    setRecommendOpen(false);
    setLuckyItem(null);
    holdOpen.current = false;
    panelOpen.current = false;
    setTime(0);
    setDuration(0);
    setCurrent(next);
    if (!hovered.current) scheduleCollapse();
  };

  const chooseVideo = (item: VideoCard) => selectVideo(item.id);

  const loadBrowsePage = async (page: number) => {
    const res = await api.feed(page, 20);
    const incoming = (res?.items || []).map((item) => item.id);
    const previous = page === 1 ? [] : browseFeed.current.ids;
    browseFeed.current = {
      ids: [...new Set([...previous, ...incoming])],
      page,
      pages: res?.pagination?.pages ?? (incoming.length ? page : Math.max(0, page - 1)),
    };
  };

  const changeVideo = async (delta: number) => {
    if (switchingVideo.current) return;
    switchingVideo.current = true;
    setVideoSwitching(true);
    const request = ++videoIntent.current;
    try {
      const mainIds = readFeedIds();
      const cachedIds = browseFeed.current.ids;
      // 小窗已经往后浏览时继续自己的缓存；否则优先跟随主界面片单。
      let ids = current && cachedIds.includes(current.id)
        ? cachedIds
        : mainIds.length ? mainIds : cachedIds;
      let index = current ? ids.indexOf(current.id) : -1;
      let target = index < 0 ? (delta > 0 ? 0 : ids.length - 1) : index + delta;
      if (target < 0) {
        showNotice("已经是第一部");
        return;
      }

      if (!ids.length || target >= ids.length) {
        if (delta < 0 && ids.length) {
          showNotice("已经是第一部");
          return;
        }
        if (!browseFeed.current.ids.length || (current && !browseFeed.current.ids.includes(current.id))) {
          await loadBrowsePage(1);
          if (request !== videoIntent.current) return;
        }
        while (target >= browseFeed.current.ids.length && browseFeed.current.page < browseFeed.current.pages) {
          await loadBrowsePage(browseFeed.current.page + 1);
          if (request !== videoIntent.current) return;
        }
        ids = browseFeed.current.ids;
        index = current ? ids.indexOf(current.id) : -1;
        target = index < 0 ? (delta > 0 ? 0 : ids.length - 1) : index + delta;
      }

      const id = ids[target];
      if (id) selectVideo(id);
      else showNotice(delta > 0 ? "已经到最新一部" : "已经是第一部");
    } catch (error) {
      invoke("debug_log", { msg: `[moyu] browse ${String(error)}` }).catch(() => {});
      showNotice("片单加载失败，请重试");
    } finally {
      switchingVideo.current = false;
      setVideoSwitching(false);
    }
  };

  const cancelNextPress = () => {
    if (nextPressTimer.current) window.clearTimeout(nextPressTimer.current);
    nextPressTimer.current = undefined;
  };

  const onNextPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || switchingVideo.current) return;
    cancelNextPress();
    nextLongPressed.current = false;
    nextPressTimer.current = window.setTimeout(() => {
      nextPressTimer.current = undefined;
      nextLongPressed.current = true;
      void changeVideo(-1);
    }, 550);
  };

  const openRecommend = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    holdTimer.current = undefined;
    panelOpen.current = true;
    setSearchOpen(false);
    setRecommendOpen(true);
  };

  const closeRecommend = () => {
    recommendRequest.current += 1;
    holdOpen.current = false;
    panelOpen.current = false;
    setRecommendOpen(false);
    setRecommendLoading(false);
    setLuckyItem(null);
    if (!hovered.current) scheduleCollapse();
  };

  const closeSearch = () => {
    holdOpen.current = false;
    panelOpen.current = false;
    setSearchOpen(false);
    if (!hovered.current) scheduleCollapse();
  };

  const toggleSearch = () => {
    if (searchOpen) {
      closeSearch();
      return;
    }
    if (recommendOpen) {
      recommendRequest.current += 1;
      setRecommendOpen(false);
      setRecommendLoading(false);
      setLuckyItem(null);
    }
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    holdTimer.current = undefined;
    panelOpen.current = true;
    setSearchOpen(true);
  };

  const randomRecommend = () => {
    const pool = luckyItem && recommendItems.length > 1
      ? recommendItems.filter((item) => item.id !== luckyItem.id)
      : recommendItems;
    if (!pool.length) return;
    setLuckyItem(pool[Math.floor(Math.random() * pool.length)]);
  };

  const visibleRecommendations = recommendItems.length <= 4
    ? recommendItems
    : Array.from({ length: 4 }, (_, index) => recommendItems[(recommendBatch * 4 + index) % recommendItems.length]);

  const onBarPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Grip 已使用 Tauri 原生拖动，父层不能再发起第二次拖动；右键也不触发展开。
    if (expandedRef.current || e.button !== 0 || (e.target as Element).closest(".moyu-grip")) return;
    barDragging.current = true;
    barDrag.current = { x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onBarPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = barDrag.current;
    if (!d || d.moved) return;
    if ((e.buttons & 1) === 0) {
      barDrag.current = null;
      barDragging.current = false;
      return;
    }
    if (Math.abs(e.clientX - d.x) > 4 || Math.abs(e.clientY - d.y) > 4) {
      d.moved = true;
      dragging.current = true;
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      void win.startDragging().catch(() => {
        dragging.current = false;
      });
    }
  };

  const onBarPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = barDrag.current;
    barDrag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d && !d.moved && e.button === 0) expandNow();
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
        hovered.current = false;
        setShowControls(false);
        if (searchOpen || recommendOpen) return;
        if (holdOpen.current) {
          if (holdTimer.current) window.clearTimeout(holdTimer.current);
          holdTimer.current = window.setTimeout(() => {
            holdTimer.current = undefined;
            holdOpen.current = false;
            if (!hovered.current) scheduleCollapse();
          }, 700);
        } else {
          scheduleCollapse();
        }
      }}
      onPointerUp={() => {
        resizing.current = false;
        dragging.current = false;
        if (!hovered.current && !searchOpen && !recommendOpen) scheduleCollapse();
      }}
      onPointerCancel={() => {
        // 原生拖动开始也可能触发 pointercancel，真正结束以全局左键松开为准。
        if (barDrag.current && !barDrag.current.moved) {
          barDrag.current = null;
          barDragging.current = false;
        }
      }}
      onMouseEnter={scheduleExpand}
      onMouseLeave={() => {
        hovered.current = false;
        scheduleCollapse();
      }}
      onPointerMove={(e) => {
        if (!expanded) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const nearBottomRight = e.clientX >= rect.right - 64 && e.clientY >= rect.bottom - 64;
        const nearTopRight = e.clientX >= rect.right - 64 && e.clientY <= rect.top + 64;
        const nearResize = nearBottomRight || nearTopRight;
        holdOpen.current = nearResize;
        setShowControls(e.clientY - rect.top >= rect.height - 52 || searchOpen || recommendOpen || showVolume);
        if (nearResize && hideTimer.current) window.clearTimeout(hideTimer.current);
      }}
      onWheel={(e) => {
        // 搜索列表和输入框保留原生滚轮行为，避免滚动结果时连带改变透明度。
        if ((e.target as Element).closest("input, textarea, .moyu-search-list")) return;
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
          onPointerCancel={() => {
            if (barDrag.current && !barDrag.current.moved) {
              barDrag.current = null;
              barDragging.current = false;
            }
          }}
        >
          <div
            className="moyu-grip"
            data-tauri-drag-region
            title="按住拖动小条"
            onPointerDown={() => {
              barDragging.current = true;
            }}
            onPointerUp={() => {
              barDragging.current = false;
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
          {recommendOpen && (
            <section className="moyu-recommend" aria-label="推荐台" onWheel={(e) => e.stopPropagation()}>
              <div className="moyu-rec-head">
                <strong>{luckyItem ? "🎲 随缘一部" : "✦ 推荐台"}</strong>
                <button type="button" aria-label="关闭推荐" onClick={closeRecommend}>✕</button>
              </div>
              <div className="moyu-rec-tabs">
                {RECOMMEND_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    className={recommendTab === tab.key ? "is-active" : ""}
                    onClick={() => setRecommendTab(tab.key)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              {luckyItem ? (
                <div className="moyu-lucky">
                  <div className="moyu-lucky-cover">
                    <img src={cover(luckyItem.cover)} alt="" draggable={false} />
                  </div>
                  <strong className="moyu-lucky-title">{luckyItem.title}</strong>
                  <div className="moyu-lucky-meta">
                    {luckyItem.episode_count ? `${luckyItem.is_finished ? "已完结" : "更新至"} ${luckyItem.episode_count} 集` : "精选推荐"}
                    {luckyItem.score !== undefined ? ` · ${luckyItem.score} 分` : ""}
                  </div>
                  <p className="moyu-lucky-desc">
                    {luckyItem.description || luckyItem.tags?.join(" · ") || "看看这部是不是你的菜"}
                  </p>
                  <div className="moyu-lucky-actions">
                    <button type="button" className="is-primary" onClick={() => selectVideo(luckyItem.id)}>就它了</button>
                    <button type="button" onClick={randomRecommend}>再抽一次</button>
                    <button type="button" onClick={() => setLuckyItem(null)}>返回</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="moyu-rec-hint">{recommendHint || "挑一部合口味的"}</div>
                  <div className="moyu-rec-list">
                    {recommendLoading ? (
                      <div className="moyu-rec-empty">正在挑剧…</div>
                    ) : recommendError ? (
                      <div className="moyu-rec-empty">{recommendError}</div>
                    ) : visibleRecommendations.length ? (
                      <div className="moyu-rec-grid">
                        {visibleRecommendations.map((item) => (
                          <button key={item.id} type="button" className="moyu-rec-card" onClick={() => selectVideo(item.id)}>
                            <span className="moyu-rec-cover">
                              <img src={cover(item.cover)} alt="" loading="lazy" draggable={false} />
                              <i>{item.episode_count ? `${item.is_finished ? "完结" : "更新"}${item.episode_count}集` : "推荐"}</i>
                            </span>
                            <strong>{item.title}</strong>
                            <small>{item.tags?.slice(0, 2).join(" · ") || (item.score !== undefined ? `${item.score} 分` : "为你推荐")}</small>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="moyu-rec-empty">暂时没有推荐，换个分类看看</div>
                    )}
                  </div>
                  <div className="moyu-rec-footer">
                    <button
                      type="button"
                      disabled={recommendLoading || recommendItems.length <= 4}
                      onClick={() => setRecommendBatch((value) => value + 1)}
                    >
                      换一批
                    </button>
                    <button type="button" disabled={recommendLoading || !recommendItems.length} onClick={randomRecommend}>
                      🎲 随缘一部
                    </button>
                  </div>
                </>
              )}
            </section>
          )}
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
                <button type="button" aria-label="关闭搜索" onClick={closeSearch}>✕</button>
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
          {notice && <div className="moyu-notice">{notice}</div>}
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
              aria-label="下一部，长按或右键上一部"
              title="单击下一部 · 长按/右键上一部"
              disabled={videoSwitching}
              onPointerDown={onNextPointerDown}
              onPointerUp={cancelNextPress}
              onPointerLeave={cancelNextPress}
              onPointerCancel={cancelNextPress}
              onClick={() => {
                if (nextLongPressed.current) {
                  nextLongPressed.current = false;
                  return;
                }
                void changeVideo(1);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void changeVideo(-1);
              }}
            >
              {videoSwitching ? "…" : "≫"}
            </button>
            <button type="button" aria-label="推荐台" title="精选 / 热门 / 同类推荐" onClick={recommendOpen ? closeRecommend : openRecommend}>
              ✦
            </button>
            <button
              type="button"
              aria-label={muted ? "取消静音" : "静音"}
              onClick={() => setShowVolume((v) => !v)}
            >
              {muted || volume === 0 ? "🔇" : "🔊"}
            </button>
            <button type="button" aria-label="搜索其他剧" title="搜索其他剧" onClick={toggleSearch}>
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
