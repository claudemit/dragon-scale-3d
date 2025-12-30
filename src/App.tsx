import React, { useState, useRef, useMemo, useEffect, Suspense } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Environment, OrbitControls, Float, useVideoTexture, useTexture } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import * as THREE from 'three';
import { easing } from 'maath';
import { v4 as uuidv4 } from 'uuid';

// --- 💾 0. IndexedDB 持久化工具 (新增) ---
const DB_NAME = 'DragonScaleDB';
const STORE_NAME = 'assets';
const META_KEY = 'meta_config'; // 存储 zone2ImageCount 等配置

const dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
  if (typeof window === 'undefined') return;
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = (event) => {
    const db = (event.target as IDBOpenDBRequest).result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME);
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const dbUtils = {
  // 保存文件 Blob
  saveAsset: async (key: string, file: Blob | string) => {
    const db = await dbPromise;
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      // 如果是 Blob 直接存，如果是 string (base64) 也直接存
      store.put(file, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  // 读取文件
  getAsset: async (key: string): Promise<Blob | string | undefined> => {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  // 保存配置 (如数量)
  saveConfig: (count: number) => {
    localStorage.setItem(META_KEY, JSON.stringify({ zone2Count: count }));
  },
  // 读取配置
  getConfig: () => {
    const str = localStorage.getItem(META_KEY);
    return str ? JSON.parse(str) : null;
  },
  // 清空所有数据
  clearAll: async () => {
    const db = await dbPromise;
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => {
        localStorage.removeItem(META_KEY);
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }
};

// --- 📐 1. 物理参数 ---
const PAGE_WIDTH = 4.0;
const PAGE_HEIGHT = 3.0;
const RATIO = 0.2;
const ZONE_RIGHT_WIDTH = PAGE_WIDTH * RATIO;
const ZONE_LEFT_WIDTH = PAGE_WIDTH - ZONE_RIGHT_WIDTH;
const Z_THICKNESS = 0.015;
const GROUP_SIZE = 5;
const TOTAL_ZONE2_ASPECT = (ZONE_RIGHT_WIDTH * GROUP_SIZE) / PAGE_HEIGHT;

// --- 🛠️ 辅助：生成本地占位图 ---
const createPlaceholder = (color: string, text: string) => {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 512, 512);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = 'bold 100px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 256);
  }
  return canvas.toDataURL();
};

const PLACEHOLDERS = {
  ZONE1: createPlaceholder('#2d3748', 'FRONT'),
  ZONE2: createPlaceholder('#3182ce', 'SPINE'),
  ZONE3: createPlaceholder('#805ad5', 'BACK'),
};

// --- 🛠️ 辅助：生成粒子柔光贴图 ---
const getGlowSpriteTexture = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 32; canvas.height = 32;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.5, 'rgba(255,255,255,0.1)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 32, 32);
  }
  return new THREE.CanvasTexture(canvas);
};

// --- 🛠️ 材质组件 ---
interface ContentMaterialProps {
  url: string; type: 'image' | 'video'; side: THREE.Side; targetSize: [number, number];
  opacity?: number; transparent?: boolean; isSlice?: boolean; sliceIndex?: number; mirror?: boolean;
  highlight?: boolean; flashIntensity?: number;
  isVisible?: boolean;
}

// 核心渲染器
const ContentRender = ({
  url, type, side, targetSize,
  opacity = 1, transparent = false,
  isSlice = false, sliceIndex = 0,
  mirror = false, highlight = false,
  flashIntensity = 0,
  isVisible = false
}: ContentMaterialProps) => {
  const [textureAspect, setTextureAspect] = useState(1);
  const textureRef = useRef<THREE.Texture | null>(null);
  const pauseTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const retryIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const texture = type === 'video'
    ? useVideoTexture(url, { muted: true, loop: true, start: false, playsInline: true, crossOrigin: 'Anonymous' })
    : useTexture(url);

  if (texture) texture.colorSpace = THREE.SRGBColorSpace;

  // --- 🎬 播放控制 ---
  useEffect(() => {
    if (type !== 'video' || !texture || !texture.image) return;
    const videoEl = texture.image as HTMLVideoElement;
    videoEl.muted = true; videoEl.loop = true; videoEl.playsInline = true;

    if (retryIntervalRef.current) { clearInterval(retryIntervalRef.current); retryIntervalRef.current = null; }

    if (isVisible) {
      if (pauseTimeoutRef.current) { clearTimeout(pauseTimeoutRef.current); pauseTimeoutRef.current = null; }
      const attemptPlay = async () => { if (videoEl.paused) { try { await videoEl.play(); } catch (e) { } } };
      attemptPlay();
      retryIntervalRef.current = setInterval(() => {
        if (videoEl.paused && videoEl.readyState >= 1) attemptPlay();
        else if (!videoEl.paused && retryIntervalRef.current) { clearInterval(retryIntervalRef.current); retryIntervalRef.current = null; }
      }, 250);
    } else {
      if (retryIntervalRef.current) { clearInterval(retryIntervalRef.current); retryIntervalRef.current = null; }
      if (!pauseTimeoutRef.current) {
        pauseTimeoutRef.current = setTimeout(() => { videoEl.pause(); pauseTimeoutRef.current = null; }, 2000);
      }
    }
    return () => {
      if (pauseTimeoutRef.current) clearTimeout(pauseTimeoutRef.current);
      if (retryIntervalRef.current) clearInterval(retryIntervalRef.current);
    };
  }, [isVisible, type, texture]);

  // --- 宽高比 ---
  useEffect(() => {
    if (!texture) return;
    textureRef.current = texture;
    const updateAspect = () => {
      let aspect = 1;
      if (texture.image) {
        const img = texture.image;
        const w = img.videoWidth || img.width;
        const h = img.videoHeight || img.height;
        if (w && h) aspect = w / h;
      }
      setTextureAspect(aspect);
    };
    if (type === 'video') {
      const vid = texture.image as HTMLVideoElement;
      if (vid.readyState >= vid.HAVE_METADATA) updateAspect();
      else vid.addEventListener('loadedmetadata', updateAspect);
      return () => vid.removeEventListener('loadedmetadata', updateAspect);
    } else { updateAspect(); }
  }, [texture, type, url]);

  // --- 纹理映射 ---
  const tex = useMemo(() => {
    if (!texture) return null;
    const t = texture.clone();
    t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.ClampToEdgeWrapping;

    if (isSlice) {
      const groupAspect = TOTAL_ZONE2_ASPECT;
      let gx = 1, gy = 1;
      if (textureAspect > groupAspect) { gx = groupAspect / textureAspect; gy = 1; }
      else { gx = 1; gy = textureAspect / groupAspect; }
      const gox = (1 - gx) / 2; const goy = (1 - gy) / 2;
      const sliceFraction = 1 / GROUP_SIZE;
      t.repeat.set(gx * sliceFraction, gy);
      t.offset.set((sliceIndex * sliceFraction * gx) + gox, goy);
    } else {
      const planeAspect = targetSize[0] / targetSize[1];
      let rx = 1, ry = 1;
      if (textureAspect > planeAspect) { rx = planeAspect / textureAspect; }
      else { ry = textureAspect / planeAspect; }
      let ox = (1 - rx) / 2; let oy = (1 - ry) / 2;
      if (mirror) { rx = -rx; ox = 1 - ox; }
      t.repeat.set(rx, ry);
      t.offset.set(ox, oy);
    }
    t.needsUpdate = true;
    return t;
  }, [texture, textureAspect, targetSize, isSlice, sliceIndex, mirror]);

  const emissiveColor = highlight ? "#00ff00" : (flashIntensity > 0.1 ? "#aaddff" : "black");
  const currentEmissiveIntensity = highlight ? 0.5 : flashIntensity;

  return (
    <meshStandardMaterial
      map={tex} side={side} roughness={1.0} metalness={0.0}
      transparent={transparent} opacity={opacity}
      emissive={emissiveColor}
      emissiveIntensity={currentEmissiveIntensity}
      toneMapped={false}
    />
  );
};

const SafeContentMaterial = (props: ContentMaterialProps) => {
  return (
    <Suspense fallback={<meshStandardMaterial color="#222" />}>
      <ContentRender {...props} />
    </Suspense>
  );
};

// --- ✨ 定制粒子系统 ---
const CustomParticleSystem = ({ count, color, size, spread, speed }: any) => {
  const points = useRef<THREE.Points>(null);
  const sprite = useMemo(() => getGlowSpriteTexture(), []);

  const [positions, randoms] = useMemo(() => {
    const pos = new Float32Array(count * 3);
    const rnd = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * spread.x;
      pos[i * 3 + 1] = (Math.random() - 0.5) * spread.y;
      pos[i * 3 + 2] = (Math.random() - 0.5) * spread.z;
      rnd[i] = Math.random();
    }
    return [pos, rnd];
  }, [count, spread]);

  useFrame((state) => {
    if (!points.current) return;
    const time = state.clock.elapsedTime;
    const posAttr = points.current.geometry.attributes.position;
    if (!posAttr) return;
    const positionsArr = posAttr.array as Float32Array;

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const rnd = randoms[i];
      positionsArr[i3 + 1] += Math.sin(time * speed + rnd * 10) * 0.02;
    }
    posAttr.needsUpdate = true;
  });

  return (
    <points ref={points}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={count} array={positions} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial
        map={sprite}
        color={color}
        size={size}
        sizeAttenuation={true}
        transparent={true}
        opacity={1.0}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        toneMapped={false}
      />
    </points>
  );
};

const DebrisParticles = () => {
  const colors = useMemo(() => ({
    core: new THREE.Color("#ffaa44").multiplyScalar(10),
    outer: new THREE.Color("#4488ff").multiplyScalar(8)
  }), []);

  return (
    <group>
      <CustomParticleSystem
        count={20} color={colors.core} size={0.8} speed={2.0}
        spread={{ x: PAGE_WIDTH * 1.5, y: PAGE_HEIGHT * 1.5, z: 2 }}
      />
      <CustomParticleSystem
        count={50} color={colors.outer} size={1.5} speed={1.0}
        spread={{ x: PAGE_WIDTH * 3, y: PAGE_HEIGHT * 3, z: 5 }}
      />
    </group>
  );
};

// --- 📄 单个龙鳞页组件 ---
interface LeafProps {
  index: number; total: number;
  zone1Url: string; zone1Type: 'image' | 'video';
  zone2Url: string; zone2Type: 'image' | 'video';
  zone3Url: string; zone3Type: 'image' | 'video';
  isOpen: boolean; flippedIndex: number; setFlippedIndex: (i: number) => void;
  hoveredIndex: number | null; setHoveredIndex: (i: number | null) => void;
  isEditMode: boolean; onZoneClick: (index: number, zone: 'zone1' | 'zone2' | 'zone3') => void;
  isExploded: boolean;
}

const DragonScalePage = ({
  index, total,
  zone1Url, zone1Type, zone2Url, zone2Type, zone3Url, zone3Type,
  isOpen, flippedIndex, setFlippedIndex, hoveredIndex, setHoveredIndex,
  isEditMode, onZoneClick, isExploded
}: LeafProps) => {
  const group = useRef<THREE.Group>(null);
  const [hoveredZone, setHoveredZone] = useState<'zone1' | 'zone2' | 'zone3' | null>(null);
  const [flash, setFlash] = useState(0);
  const [isInView, setIsInView] = useState(false);
  const [isFrontFacing, setIsFrontFacing] = useState(true);
  const { camera } = useThree();
  const tempVec = useMemo(() => new THREE.Vector3(), []);
  const tempForward = useMemo(() => new THREE.Vector3(0, 0, 1), []);
  const tempCameraDir = useMemo(() => new THREE.Vector3(), []);
  const isFlipped = index <= flippedIndex;
  const sliceIndex = index % GROUP_SIZE;

  useEffect(() => { setFlash(2.0); }, [isFlipped, isOpen]);

  const explosionParams = useMemo(() => {
    const heightSpread = 20 + (total * 0.6);
    const radiusBase = 5 + (total * 0.1);
    const radiusVar = 5 + (total * 0.15);
    return {
      orbitRadius: radiusBase + Math.random() * radiusVar,
      yBase: (index - total / 2) * (heightSpread / total) * 1.5,
      yJitter: (Math.random() - 0.5) * 5,
      speed: 1.0 + Math.random() * 2.0,
      rotSpeedX: (Math.random() - 0.5) * 6,
      rotSpeedY: (Math.random() - 0.5) * 6,
      phase: Math.random() * Math.PI * 2
    };
  }, [total, index]);

  useFrame((state, delta) => {
    if (flash > 0) setFlash(v => Math.max(0, v - delta * 8));
    if (!group.current) return;
    let tx = 0, ty = 0, tz = 0, rotX = 0, rotY = 0, rotZ = 0;
    if (isExploded) {
      const t = state.clock.elapsedTime;
      const { orbitRadius, yBase, yJitter, speed, rotSpeedX, rotSpeedY, phase } = explosionParams;
      const theta = t * speed + index * 0.1 + phase;
      const dynamicRadius = orbitRadius + Math.sin(t * 1.5 + index) * 2.0;
      tx = Math.cos(theta) * dynamicRadius;
      tz = Math.sin(theta) * dynamicRadius;
      ty = yBase + yJitter + Math.sin(t + index) * 2.0;
      rotX = t * rotSpeedX; rotY = t * rotSpeedY; rotZ = t * 0.3;
    } else if (!isOpen) {
      tx = (index - total / 2) * ZONE_RIGHT_WIDTH;
      tz = (total - index) * Z_THICKNESS;
      if (isFlipped) { rotY = -Math.PI * 0.95; tx -= 0.6; tz += 0.8; }
      else { rotY = 0; if (hoveredIndex === index && !isFlipped && !isEditMode) { rotY = -0.15; tz += 0.2; } }
    } else {
      const startRadius = 3.0; const radiusStep = 0.15; const angleStep = 0.18;
      const i = index - total / 2; const theta = i * angleStep;
      const r = startRadius + (index * radiusStep);
      tx = r * Math.cos(theta); tz = r * Math.sin(theta);
      const baseRotY = -theta + Math.PI / 2 + 0.2;
      if (isFlipped) {
        const innerR = r - 3.0; tx = innerR * Math.cos(theta); tz = innerR * Math.sin(theta);
        ty = 0.5; rotY = baseRotY - Math.PI * 0.95;
      } else {
        rotY = baseRotY; if (hoveredIndex === index && !isFlipped && !isEditMode) ty = 0.5;
      }
    }
    const damp = isExploded ? 0.1 : 0.4;
    easing.damp3(group.current.position, [tx, ty, tz], damp, delta);
    easing.dampE(group.current.rotation, [rotX, rotY, rotZ], damp, delta);

    tempVec.set(PAGE_WIDTH / 2, 0, 0);
    group.current.localToWorld(tempVec);
    tempVec.project(camera);

    const threshold = 0.3;
    const isCenterX = tempVec.x > -threshold && tempVec.x < threshold;
    const isCenterY = tempVec.y > -threshold && tempVec.y < threshold;
    const isVisibleScreen = isCenterX && isCenterY && tempVec.z < 1 && tempVec.z > 0;

    if (isVisibleScreen !== isInView) setIsInView(isVisibleScreen);

    if (isVisibleScreen) {
      tempForward.set(0, 0, 1).applyQuaternion(group.current.quaternion).normalize();
      group.current.getWorldPosition(tempCameraDir);
      tempCameraDir.subVectors(camera.position, tempCameraDir).normalize();
      const dot = tempForward.dot(tempCameraDir);
      const isFront = dot > -0.1;
      if (isFront !== isFrontFacing) setIsFrontFacing(isFront);
    }
  });

  const renderContent = (url: string, type: 'image' | 'video', side: THREE.Side, size: [number, number], isSlice = false, sliceIdx = 0, isMirror = false, isHover = false, shouldPlay = false) => (
    <SafeContentMaterial
      url={url} type={type} side={side} targetSize={size} isSlice={isSlice} sliceIndex={sliceIdx} mirror={isMirror}
      highlight={isHover} flashIntensity={flash} isVisible={shouldPlay}
    />
  );

  return (
    <group ref={group}>
      <group
        onClick={(e) => { if (!isEditMode && !isExploded) { e.stopPropagation(); setFlippedIndex(isFlipped ? index - 1 : index); } }}
        onPointerOver={(e) => { if (!isEditMode && !isExploded) { e.stopPropagation(); setHoveredIndex(index); } }}
        onPointerOut={() => { if (!isEditMode && !isExploded) { setHoveredIndex(null); } }}
      >
        {isExploded && <DebrisParticles />}
        <mesh position={[ZONE_LEFT_WIDTH / 2, 0, 0]} onClick={(e) => { if (isEditMode) { e.stopPropagation(); onZoneClick(index, 'zone1'); } }} onPointerOver={(e) => { if (isEditMode) { e.stopPropagation(); setHoveredZone('zone1'); } }} onPointerOut={() => setHoveredZone(null)}>
          <planeGeometry args={[ZONE_LEFT_WIDTH, PAGE_HEIGHT]} />
          {renderContent(zone1Url, zone1Type, THREE.FrontSide, [ZONE_LEFT_WIDTH, PAGE_HEIGHT], false, 0, false, isEditMode && hoveredZone === 'zone1', isInView && isFrontFacing)}
          <mesh position={[-ZONE_LEFT_WIDTH / 2 + 0.01, 0, 0.01]}><planeGeometry args={[0.02, PAGE_HEIGHT]} /><meshBasicMaterial color="white" opacity={0.3} transparent /></mesh>
        </mesh>
        <mesh position={[ZONE_LEFT_WIDTH + ZONE_RIGHT_WIDTH / 2, 0, 0]} onClick={(e) => { if (isEditMode) { e.stopPropagation(); onZoneClick(index, 'zone2'); } }} onPointerOver={(e) => { if (isEditMode) { e.stopPropagation(); setHoveredZone('zone2'); } }} onPointerOut={() => setHoveredZone(null)}>
          <planeGeometry args={[ZONE_RIGHT_WIDTH, PAGE_HEIGHT]} />
          {renderContent(zone2Url, zone2Type, THREE.FrontSide, [ZONE_RIGHT_WIDTH, PAGE_HEIGHT], true, sliceIndex, false, isEditMode && hoveredZone === 'zone2', isInView && isFrontFacing)}
        </mesh>
        <mesh position={[PAGE_WIDTH / 2, 0, -0.01]} onClick={(e) => { if (isEditMode) { e.stopPropagation(); onZoneClick(index, 'zone3'); } }} onPointerOver={(e) => { if (isEditMode) { e.stopPropagation(); setHoveredZone('zone3'); } }} onPointerOut={() => setHoveredZone(null)}>
          <planeGeometry args={[PAGE_WIDTH, PAGE_HEIGHT]} />
          {renderContent(zone3Url, zone3Type, THREE.BackSide, [PAGE_WIDTH, PAGE_HEIGHT], false, 0, true, isEditMode && hoveredZone === 'zone3', isInView && !isFrontFacing)}
        </mesh>
      </group>
    </group>
  );
};

// --- 📱 主应用 ---
export default function App() {
  const [isOpen, setIsOpen] = useState(false);
  const [isExploded, setIsExploded] = useState(false);
  const [flippedIndex, setFlippedIndex] = useState<number>(-1);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  // 默认值为3，稍后 useEffect 会覆盖
  const [zone2ImageCount, setZone2ImageCountState] = useState<number>(3);
  const [isEditMode, setIsEditMode] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editTargetRef = useRef<{ index: number, zone: 'zone1' | 'zone2' | 'zone3' } | null>(null);

  // 状态定义
  const [zone2Items, setZone2Items] = useState<{ url: string, type: 'image' | 'video' }[]>([]);
  const [zone1Items, setZone1Items] = useState<{ url: string, type: 'image' | 'video' }[]>([]);
  const [zone3Items, setZone3Items] = useState<{ url: string, type: 'image' | 'video' }[]>([]);

  // 包装一下 setZone2ImageCount，同步保存到 localStorage
  const setZone2ImageCount = (val: number) => {
    setZone2ImageCountState(val);
    dbUtils.saveConfig(val);
  };

  const LEAF_COUNT = zone2ImageCount * GROUP_SIZE;

  // --- 🚀 初始化：从 IndexedDB 恢复数据 ---
  useEffect(() => {
    const loadData = async () => {
      // 1. 恢复数量配置
      const config = dbUtils.getConfig();
      const count = config?.zone2Count || 3;
      setZone2ImageCountState(count);

      // 2. 恢复媒体文件
      // 我们并不知道具体保存了多少个，但我们可以遍历当前预期的数量范围
      // 或者更简单：因为是稀疏数组，我们直接按 logic 加载

      const totalLeaves = count * GROUP_SIZE;

      // 辅助函数：加载单个 zone 数组
      const loadZoneArray = async (prefix: string, length: number, isGrouped = false) => {
        const arr = [];
        for (let i = 0; i < length; i++) {
          const key = `${prefix}_${i}`;
          try {
            const data = await dbUtils.getAsset(key);
            if (data) {
              // 这里的 data 可能是 Blob (文件) 或 string (base64)
              // URL.createObjectURL 对 Blob 和 File 都有效
              let url = '';
              let type: 'image' | 'video' = 'image';

              if (data instanceof Blob) {
                url = URL.createObjectURL(data);
                type = data.type.startsWith('video') ? 'video' : 'image';
              } else if (typeof data === 'string') {
                url = data; // base64
                type = 'image'; // 假设 string 都是图片
              }
              arr[i] = { url, type };
            }
          } catch (e) {
            // 如果读取失败，就留空，渲染时会用 placeholder
          }
        }
        return arr;
      };

      const z2 = await loadZoneArray('zone2', count, true);
      const z1 = await loadZoneArray('zone1', totalLeaves);
      const z3 = await loadZoneArray('zone3', totalLeaves);

      setZone2Items(z2);
      setZone1Items(z1);
      setZone3Items(z3);
    };

    loadData();
  }, []); // 仅挂载时执行一次

  // --- 🧹 重置功能 ---
  const handleReset = async () => {
    if (window.confirm("确认要清空所有已上传的图片/视频并恢复默认设置吗？")) {
      await dbUtils.clearAll();
      window.location.reload(); // 简单粗暴最有效，彻底清理内存和状态
    }
  };

  // 图片压缩 (保存原图太大，压缩后存 base64 或 blob)
  const compressImage = (file: File): Promise<{ url: string, blob: Blob }> => {
    return new Promise((resolve) => {
      const img = new Image();
      const rawUrl = URL.createObjectURL(file);
      img.src = rawUrl;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const maxDim = 1024;
        let w = img.width; let h = img.height;
        if (w > maxDim || h > maxDim) {
          const scale = maxDim / Math.max(w, h); w *= scale; h *= scale;
        }
        canvas.width = w; canvas.height = h;
        ctx?.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          if (blob) {
            resolve({ url: URL.createObjectURL(blob), blob });
          } else {
            resolve({ url: rawUrl, blob: file });
          }
        }, 'image/jpeg', 0.85);
      };
    });
  };

  const handleZoneClick = (index: number, zone: 'zone1' | 'zone2' | 'zone3') => {
    editTargetRef.current = { index, zone };
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  // --- 💾 批量处理：支持一次选中多张图 ---
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0 || !editTargetRef.current) return;

    // 1. 获取所有选中的文件
    const files = Array.from(e.target.files);
    const { index: startIndex, zone } = editTargetRef.current;

    // 2. 遍历处理每一个文件
    // 我们使用 for...of 循环来支持 await 异步操作
    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      // 计算当前文件对应的目标索引 (从点击位置开始往后排)
      // 注意：如果是 zone2 (书脊)，索引是按组(GROUP_SIZE)计算的，这里简化处理，假设用户想填满后续的每个逻辑槽位
      // 实际上 zone2 的逻辑稍微复杂一点：它对应的是 groupIndex。
      // 我们这里做一个智能判断：
      let targetIndex = 0;
      let targetGroupIndex = 0;

      if (zone === 'zone2') {
        // 书脊的情况：startIndex 是 leaf index，但数据存在 groupIndex 上
        // 我们假设用户是想填充后续的"书脊"
        const startGroupIndex = Math.floor(startIndex / GROUP_SIZE);
        targetGroupIndex = startGroupIndex + i;

        // 如果超出了当前定义的 zone2 数量，就停止
        if (targetGroupIndex >= zone2ImageCount) break;
      } else {
        // 正面(zone1) 或 背面(zone3)
        targetIndex = startIndex + i;

        // 如果超出了总页数，就停止
        if (targetIndex >= LEAF_COUNT) break;
      }

      // 3. 处理文件 (压缩图片 或 准备视频)
      const rawType = file.type.startsWith('video') ? 'video' : 'image';
      let url = "";
      let dataToSave: Blob | string = file;

      if (rawType === 'image') {
        const res = await compressImage(file);
        url = res.url;
        dataToSave = res.blob;
      } else {
        url = URL.createObjectURL(file);
        dataToSave = file;
      }

      // 4. 生成 DB Key 并保存状态
      let dbKey = '';

      if (zone === 'zone2') {
        dbKey = `zone2_${targetGroupIndex}`;
        // 更新 React 状态
        setZone2Items(prev => {
          const c = [...prev];
          c[targetGroupIndex] = { url, type: rawType };
          return c;
        });
      } else {
        dbKey = `${zone}_${targetIndex}`;
        // 更新 React 状态
        if (zone === 'zone1') {
          setZone1Items(prev => {
            const c = [...prev];
            c[targetIndex] = { url, type: rawType };
            return c;
          });
        } else {
          setZone3Items(prev => {
            const c = [...prev];
            c[targetIndex] = { url, type: rawType };
            return c;
          });
        }
      }

      // 5. 写入 IndexedDB (每一个都保存)
      // 不等待 Promise 完成，提高界面响应速度
      dbUtils.saveAsset(dbKey, dataToSave).catch(err => console.error(`Save failed for ${dbKey}:`, err));
    }

    // 重置 input value，允许重复选择相同文件
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const leaves = useMemo(() => {
    return Array.from({ length: LEAF_COUNT }).map((_, i) => {
      const groupIndex = Math.floor(i / GROUP_SIZE);
      const z2Item = zone2Items[groupIndex];
      const z1Item = zone1Items[i];
      const z3Item = zone3Items[i];
      return {
        id: uuidv4(),
        index: i,
        // 如果数据不存在，自动使用 Placeholder，实现了“回复默认状态”
        zone2Url: z2Item?.url || PLACEHOLDERS.ZONE2,
        zone2Type: z2Item?.type || 'image',
        zone1Url: z1Item?.url || PLACEHOLDERS.ZONE1,
        zone1Type: z1Item?.type || 'image',
        zone3Url: z3Item?.url || PLACEHOLDERS.ZONE3,
        zone3Type: z3Item?.type || 'image',
      };
    });
  }, [LEAF_COUNT, zone2Items, zone1Items, zone3Items]);

  return (
    <div className="w-full h-screen bg-slate-950 text-white overflow-hidden font-sans select-none">
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        accept="image/*,video/mp4"
        multiple // ✨ 开启多选支持
        onChange={handleFileChange}
      />

      <Canvas shadows flat camera={{ position: [0, 8, 22], fov: 40 }} dpr={[1, 1.5]}>
        <color attach="background" args={['#0f172a']} />
        <ambientLight intensity={1.5} />
        <spotLight position={[5, 10, 5]} intensity={1.5} castShadow />
        <EffectComposer disableNormalPass><Bloom luminanceThreshold={1.1} mipmapBlur intensity={1.0} radius={0.5} /></EffectComposer>
        <Float speed={1.5} rotationIntensity={isExploded ? 0 : 0.05} floatIntensity={isExploded ? 0 : 0.1}>
          <group position={[0, -1, 0]}>
            {leaves.map((leaf) => (
              <DragonScalePage key={leaf.id} index={leaf.index} total={LEAF_COUNT} {...leaf} isOpen={isOpen} flippedIndex={flippedIndex} setFlippedIndex={setFlippedIndex} hoveredIndex={hoveredIndex} setHoveredIndex={setHoveredIndex} isEditMode={isEditMode} onZoneClick={handleZoneClick} isExploded={isExploded} />
            ))}
          </group>
        </Float>
        <OrbitControls enablePan={true} enableZoom={true} enabled={true} mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }} />
        <Environment preset="city" />
      </Canvas>

      <div className="absolute top-0 left-0 p-6 z-10 w-full flex justify-between items-start pointer-events-none">
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight">DragonScale</h1>
          <div className="flex gap-4 mt-4">
            <div className="pointer-events-auto flex items-center gap-2 bg-slate-800/50 backdrop-blur-sm p-2 rounded-lg border border-slate-700/50 w-fit">
              <span className="text-xs text-slate-300 font-bold">Zone2 Qty:</span>
              <input type="number" min="1" max="100" value={zone2ImageCount} onChange={(e) => { const val = parseInt(e.target.value); if (val > 0) setZone2ImageCount(val); }} className="w-12 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm text-center text-white focus:outline-none focus:border-blue-500" />
            </div>
            <button onClick={() => setIsEditMode(!isEditMode)} className={`pointer-events-auto px-4 py-2 rounded-lg border flex items-center gap-2 transition-all shadow-lg ${isEditMode ? "bg-amber-600 border-amber-400 text-white" : "bg-slate-800/50 border-slate-600 text-slate-300 hover:bg-slate-700"}`}>
              {isEditMode ? "✏️ Editing Mode" : "👁️ View Mode"}
            </button>
            {/* ✨ 新增：重置按钮 */}
            <button onClick={handleReset} className="pointer-events-auto px-4 py-2 rounded-lg border border-red-500/50 text-red-300 bg-red-900/20 hover:bg-red-900/40 text-sm">
              🗑️ Reset Data
            </button>
          </div>
        </div>
      </div>

      <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-10 flex gap-4">
        <button onClick={() => { setIsOpen(!isOpen); setFlippedIndex(-1); setIsExploded(false); }} className={`pointer-events-auto px-10 py-3 backdrop-blur-md border rounded-full text-white font-bold tracking-widest shadow-2xl transition-all active:scale-95 ${isEditMode || isExploded ? "bg-slate-700/50 border-slate-600 opacity-50 cursor-not-allowed" : "bg-white/10 hover:bg-white/20 border-white/20"}`} disabled={isEditMode || isExploded}>
          {isOpen ? "CLOSE" : "OPEN (Spiral)"}
        </button>
        <button onClick={() => { setIsExploded(!isExploded); setFlippedIndex(-1); }} className={`pointer-events-auto px-6 py-3 backdrop-blur-md border rounded-full font-bold tracking-widest shadow-2xl transition-all active:scale-95 flex items-center gap-2 ${isExploded ? "bg-red-600/80 border-red-400 text-white hover:bg-red-500" : "bg-red-900/30 border-red-500/30 text-red-200 hover:bg-red-900/50"} ${isEditMode ? "opacity-50 cursor-not-allowed" : ""}`} disabled={isEditMode}>
          {isExploded ? "🛑 STOP" : "💥 EXPLODE"}
        </button>
      </div>
    </div>
  );
}