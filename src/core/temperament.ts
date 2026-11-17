/**
 * 历史律制。每种律制用 12 个音级（C=0…B=11）相对十二平均律的
 * 音分偏移表表示，偏移只与音级有关、各八度复用同一张表。
 *
 * 数据取常见调律文献的标准数值（Werckmeister III、Kirnberger III、
 * Vallotti、四分最大音差中庸全音律、毕达哥拉斯律）。
 */

export interface Temperament {
  id: string;
  name: string;
  /** 12 个音级相对平均律的偏移（音分），索引 0=C … 11=B */
  centsOffset: number[];
  description: string;
}

export const TEMPERAMENTS: Temperament[] = [
  {
    id: 'equal',
    name: '十二平均律',
    centsOffset: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    description: '现代标准律制，所有半音等宽（100 音分），各调色彩一致。',
  },
  {
    id: 'werckmeister3',
    name: 'Werckmeister III（韦克迈斯特第三律）',
    // C D Eb E F F# G Ab A Bb B
    centsOffset: [0, -9.5, -10.1, -5.6, 0.5, -11.7, -4.5, -13.7, -9.1, -6.6, -11.2, -10.1],
    description: '巴洛克常用良律，调号升降号越少越纯净，巴赫《平均律钢琴曲集》时期风格。',
  },
  {
    id: 'kirnberger3',
    name: 'Kirnberger III（基恩贝格尔第三律）',
    centsOffset: [0, -9.9, -5.9, -5.9, 0, -11.7, -3.9, -9.9, -7.8, -3.9, -7.8, -9.9],
    description: '巴赫学生 Kirnberger 的良律，含一个纯五度，适合巴洛克 repertoire。',
  },
  {
    id: 'vallotti',
    name: 'Vallotti（瓦洛蒂良律）',
    centsOffset: [0, -5.9, -7.8, -3.9, 2, -7.8, -2, -9.8, -3.9, -2, -7.8, -3.9],
    description: '18 世纪意大利良律，六个五度各收 1/6 最大音差，远关系调有明显色彩。',
  },
  {
    id: 'meantone',
    name: '四分最大音差中庸全音律',
    // 以 C 为基准：五度链 C-G-D-A-E-B-F# 各 −5.375 音分，
    // 反方向 F-Bb-Eb-Ab 各 +5.375（相对平均律，单位音分，四舍五入到 0.1）。
    // 序列按 C C# D D# E F F# G G# A A# B
    centsOffset: [0, -23.4, -6.8, 10.3, -13.7, 5.4, -17.1, -5.4, 17.1, -10.7, -1.6, -19.1],
    description: '文艺复兴/早期巴洛克常用，八个常用调的大三度纯净（386.3 音分），远关系调“狼音”明显。',
  },
  {
    id: 'pythagorean',
    name: '毕达哥拉斯律（五度相生律）',
    centsOffset: [0, 4, 8, -6, -2, 6, 2, 10, -4, 0, 8, -2],
    description: '纯五度叠生，五度纯净、大三度偏亮，适合中世纪/早期复调音乐。',
  },
];

export function getTemperament(id: string): Temperament {
  return TEMPERAMENTS.find((t) => t.id === id) ?? TEMPERAMENTS[0];
}

/** 某 midi 音在指定律制下相对平均律的偏移（音分） */
export function temperamentCents(id: string, midi: number): number {
  const t = getTemperament(id);
  return t.centsOffset[((midi % 12) + 12) % 12];
}
