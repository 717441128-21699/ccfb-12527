import { listPianos, deletePiano, type PianoProfile } from '../../core/storage';
import { store } from '../store';
import { el, toast, clearNode } from '../dom';

export function renderPianosView(root: HTMLElement): void {
  clearNode(root);

  const form = el('div', { class: 'panel' }, [
    el('h2', {}, '新增 / 编辑钢琴档案'),
    labelInput('品牌', 'brand', '如 Yamaha / 星海'),
    labelInput('型号', 'model', '如 U1 / C3X'),
    (() => {
      const wrap = el('div');
      wrap.append(
        el('label', { class: 'field-label' }, '类型'),
        el('select', { class: 'field', id: 'f-kind' }, [
          el('option', { value: 'upright' }, '立式钢琴'),
          el('option', { value: 'grand' }, '三角钢琴'),
          el('option', { value: 'other' }, '其他'),
        ]),
      );
      return wrap;
    })(),
    labelInput('序列号（可选）', 'serial'),
    labelInput('摆放位置（可选）', 'location', '如 客户家客厅 / 音乐厅'),
    (() => {
      const wrap = el('div');
      wrap.append(el('label', { class: 'field-label' }, '备注'), el('textarea', { class: 'field', id: 'f-notes', rows: '2' }));
      return wrap;
    })(),
    el('div', { class: 'row' }, [
      el('button', { class: 'btn', id: 'save-piano' }, '保存档案'),
      el('button', { class: 'btn secondary', id: 'reset-piano', hidden: true }, '取消编辑'),
    ]),
  ]);

  const listPanel = el('div', { class: 'panel' }, [el('h2', {}, '已有档案'), el('div', { id: 'piano-list' })]);
  root.append(form, listPanel);

  let editingId: string | null = null;

  const refreshList = async () => {
    const pianos = await listPianos();
    const list = listPanel.querySelector('#piano-list')!;
    clearNode(list);
    if (pianos.length === 0) {
      list.append(el('div', { class: 'empty' }, '还没有档案，先在上面添加一台钢琴。'));
      return;
    }
    for (const p of pianos) {
      const kindName = p.kind === 'grand' ? '三角' : p.kind === 'upright' ? '立式' : '其他';
      const card = el('div', { class: 'piano-card' + (store.state.currentPiano?.id === p.id ? ' selected' : '') }, [
        el('div', {}, [
          el('div', { style: 'font-weight:600' }, `${p.brand} ${p.model}`),
          el('div', { class: 'meta' }, `${kindName}${p.location ? ' · ' + p.location : ''} · ${new Date(p.createdAt).toLocaleDateString('zh-CN')}`),
        ]),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn secondary', 'data-act': 'edit' }, '编辑'),
          el('button', { class: 'btn danger', 'data-act': 'del' }, '删除'),
        ]),
      ]);
      card.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).dataset.act;
        if (act === 'edit') {
          editingId = p.id;
          (form.querySelector('#f-brand') as HTMLInputElement).value = p.brand;
          (form.querySelector('#f-model') as HTMLInputElement).value = p.model;
          (form.querySelector('#f-kind') as HTMLSelectElement).value = p.kind;
          (form.querySelector('#f-serial') as HTMLInputElement).value = p.serial ?? '';
          (form.querySelector('#f-location') as HTMLInputElement).value = p.location ?? '';
          (form.querySelector('#f-notes') as HTMLTextAreaElement).value = p.notes ?? '';
          (form.querySelector('#reset-piano') as HTMLButtonElement).hidden = false;
        } else if (act === 'del') {
          if (confirm(`确认删除「${p.brand} ${p.model}」及其全部工作记录？`)) {
            void deletePiano(p.id).then(() => {
              if (store.state.currentPiano?.id === p.id) store.selectPiano(null);
              void refreshList();
              toast('已删除');
            });
          }
        } else {
          store.selectPiano(store.state.currentPiano?.id === p.id ? null : p);
        }
      });
      list.append(card);
    }
  };

  form.querySelector('#save-piano')!.addEventListener('click', async () => {
    const brand = (form.querySelector('#f-brand') as HTMLInputElement).value.trim();
    const model = (form.querySelector('#f-model') as HTMLInputElement).value.trim();
    if (!brand || !model) return toast('请至少填写品牌和型号');
    const profile: PianoProfile = {
      id: editingId ?? crypto.randomUUID(),
      brand,
      model,
      kind: (form.querySelector('#f-kind') as HTMLSelectElement).value as PianoProfile['kind'],
      serial: (form.querySelector('#f-serial') as HTMLInputElement).value.trim() || undefined,
      location: (form.querySelector('#f-location') as HTMLInputElement).value.trim() || undefined,
      notes: (form.querySelector('#f-notes') as HTMLTextAreaElement).value.trim() || undefined,
      createdAt: editingId ? Date.now() : Date.now(),
    };
    await store.upsertPiano(profile);
    editingId = null;
    form.querySelectorAll('input, textarea').forEach((n) => ((n as HTMLInputElement).value = ''));
    (form.querySelector('#reset-piano') as HTMLButtonElement).hidden = true;
    toast('档案已保存');
    void refreshList();
  });

  form.querySelector('#reset-piano')!.addEventListener('click', () => {
    editingId = null;
    form.querySelectorAll('input, textarea').forEach((n) => ((n as HTMLInputElement).value = ''));
    (form.querySelector('#reset-piano') as HTMLButtonElement).hidden = true;
  });

  void refreshList();
}

function labelInput(label: string, id: string, placeholder = ''): HTMLElement {
  const wrap = el('div');
  wrap.append(
    el('label', { class: 'field-label' }, label),
    el('input', { class: 'field', id, placeholder }),
  );
  return wrap;
}
