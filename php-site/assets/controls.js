/* Shared progressive controls for the website and the SiYuan plugin. */
(() => {
  "use strict";
  const mount = (root = document.body, selector = 'select, input[type="datetime-local"]') => {
    const cleanups = new Map();
    const listeners = new AbortController();
    const signal = listeners.signal;
    let active = null, sequence = 0;
    const listen = (node, type, fn) => node.addEventListener(type, fn, {signal});
    const close = (restore = false) => {
      if (!active) return;
      const previous = active;
      active = null;
      previous.panel.hidden = true;
      previous.trigger.setAttribute('aria-expanded', 'false');
      previous.trigger.removeAttribute('aria-activedescendant');
      if (restore && previous.trigger.isConnected) previous.trigger.focus({preventScroll: true});
    };
    const place = () => {
      if (!active) return;
      if (!active.trigger.isConnected) { close(); return; }
      const rect = active.trigger.getBoundingClientRect(), panel = active.panel;
      const width = Math.min(Math.max(rect.width, active.calendar ? 292 : 180), window.innerWidth - 24);
      panel.style.width = `${width}px`;
      panel.style.maxHeight = `${Math.max(160, window.innerHeight - 32)}px`;
      const height = panel.getBoundingClientRect().height;
      const top = rect.bottom + 6 + height > window.innerHeight - 12 ? Math.max(12, rect.top - height - 6) : rect.bottom + 6;
      panel.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
      panel.style.top = `${top}px`;
    };
    const open = (control) => {
      close(); active = control;
      control.panel.hidden = false;
      control.trigger.setAttribute('aria-expanded', 'true');
      place();
      if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) control.panel.animate?.([{opacity: 0, transform: 'translateY(-3px)'}, {opacity: 1, transform: 'translateY(0)'}], {duration: 140, easing: 'cubic-bezier(.2,.8,.2,1)'});
    };
    const label = (input) => {
      if (input.getAttribute('aria-label')) return input.getAttribute('aria-label');
      const source = input.labels?.[0]?.cloneNode(true);
      source?.querySelectorAll('select,input,textarea,button,.field-hint').forEach(node => node.remove());
      return source?.textContent.trim() || input.name || 'Choose';
    };
    const panelFor = (input, kind) => {
      const panel = document.createElement('div');
      panel.className = `sps-control-panel sps-${kind}-panel`;
      panel.id = `sps-control-${Date.now()}-${++sequence}`;
      panel.hidden = true;
      panel.dataset.spsControlPanel = '';
      document.body.append(panel);
      return panel;
    };
    const enhanceSelect = (input) => {
      const trigger = document.createElement('button'), panel = panelFor(input, 'select');
      trigger.type = 'button'; trigger.className = 'sps-select-trigger';
      trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-controls', panel.id); trigger.setAttribute('aria-expanded', 'false');
      trigger.setAttribute('aria-label', label(input));
      panel.setAttribute('role', 'listbox'); panel.setAttribute('aria-label', label(input));
      input.after(trigger);
      const originalHidden = input.hidden; input.hidden = true;
      let items = [], cursor = input.selectedIndex, query = '', typedAt = 0;
      const control = {trigger, panel};
      const highlight = (index) => {
        cursor = index;
        items.forEach((item, i) => item.classList.toggle('is-highlighted', i === cursor));
        if (items[cursor]) {
          trigger.setAttribute('aria-activedescendant', items[cursor].id);
          items[cursor].scrollIntoView?.({block: 'nearest'});
        }
      };
      const refresh = () => {
        trigger.disabled = input.disabled;
        trigger.textContent = input.options[input.selectedIndex]?.textContent || 'Choose';
        panel.replaceChildren();
        items = Array.from(input.options, (option, index) => {
          const item = document.createElement('div');
          item.id = `${panel.id}-${index}`; item.className = 'sps-select-option'; item.dataset.value = option.value;
          item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(option.selected));
          item.setAttribute('aria-disabled', String(option.disabled || option.parentElement.disabled));
          item.textContent = option.textContent;
          panel.append(item); return item;
        });
        cursor = input.selectedIndex;
        if (active === control) highlight(cursor);
      };
      const enabled = (i) => items[i]?.getAttribute('aria-disabled') !== 'true';
      const choose = (index) => {
        if (!enabled(index) || !input.options[index]) return;
        input.selectedIndex = index;
        input.dispatchEvent(new Event('input', {bubbles: true}));
        input.dispatchEvent(new Event('change', {bubbles: true}));
        refresh(); close(true);
      };
      listen(trigger, 'click', () => {
        if (active === control) close();
        else { refresh(); open(control); highlight(input.selectedIndex); }
      });
      listen(trigger, 'keydown', event => {
        const key = event.key;
        if (key === 'Escape' && active === control) { event.preventDefault(); event.stopPropagation(); close(true); return; }
        if (key === 'Tab') { close(); return; }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
          event.preventDefault();
          if (active !== control) { refresh(); open(control); }
          let next = key === 'Home' ? 0 : key === 'End' ? items.length - 1 : cursor + (key === 'ArrowDown' ? 1 : -1);
          const step = key === 'ArrowUp' || key === 'End' ? -1 : 1;
          while (next >= 0 && next < items.length && !enabled(next)) next += step;
          if (next >= 0 && next < items.length) highlight(next);
        } else if (key === 'Enter' || key === ' ') {
          event.preventDefault();
          if (active === control) choose(cursor);
          else { refresh(); open(control); highlight(input.selectedIndex); }
        } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          query = Date.now() - typedAt > 700 ? key : query + key; typedAt = Date.now();
          if (active !== control) { refresh(); open(control); }
          const index = items.findIndex((item, i) => enabled(i) && item.textContent.toLowerCase().startsWith(query.toLowerCase()));
          if (index >= 0) highlight(index);
        }
      });
      listen(panel, 'pointermove', event => { const index = items.indexOf(event.target.closest('[role="option"]')); if (index >= 0 && enabled(index)) highlight(index); });
      listen(panel, 'pointerdown', event => event.preventDefault());
      listen(panel, 'click', event => choose(items.indexOf(event.target.closest('[role="option"]'))));
      listen(input, 'change', refresh);
      listen(input.form || input, 'reset', () => queueMicrotask(refresh));
      listen(input, 'invalid', () => trigger.focus());
      const observer = new MutationObserver(refresh);
      observer.observe(input, {childList: true, subtree: true, attributes: true});
      refresh();
      return () => { observer.disconnect(); input.hidden = originalHidden; trigger.remove(); panel.remove(); };
    };
    const enhanceDate = (input) => {
      const wrapper = document.createElement('div'), trigger = document.createElement('button');
      wrapper.className = 'sps-date-field';
      input.before(wrapper); wrapper.append(input, trigger);
      const oldPlaceholder = input.getAttribute('placeholder'), oldPattern = input.getAttribute('pattern');
      input.type = 'text'; input.placeholder = 'YYYY-MM-DDTHH:mm';
      input.pattern = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}';
      const validate = () => {
        const value = input.value;
        const date = new Date(value);
        const format = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        input.setCustomValidity(!value || (Number.isFinite(date.getTime()) && format(date) === value && (!input.min || value >= input.min) && (!input.max || value <= input.max)) ? '' : 'Enter a valid date and time: YYYY-MM-DDTHH:mm.');
      };
      listen(input, 'input', validate);
      trigger.type = 'button'; trigger.className = 'sps-date-trigger';
      trigger.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h1m6 0h1m-8 3h1"/></svg>';
      trigger.setAttribute('aria-label', `Choose date: ${label(input)}`); trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false');
      const panel = panelFor(input, 'date');
      panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Choose date and time'); trigger.setAttribute('aria-controls', panel.id);
      const control = {trigger, panel, calendar: true};
      let month, selected, time;
      const iso = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
      const commit = () => {
        if (!selected) return;
        input.value = `${selected}T${time.value}`;
        validate();
        input.dispatchEvent(new Event('input', {bubbles: true})); input.dispatchEvent(new Event('change', {bubbles: true}));
      };
      const button = (text, name, fn) => {
        const node = document.createElement('button'); node.type = 'button'; node.textContent = text;
        if (name) node.setAttribute('aria-label', name);
        node.addEventListener('click', fn); return node;
      };
      const draw = (focusDay = null) => {
        const rememberedTime = time?.value || input.value.slice(11) || '12:00';
        panel.replaceChildren();
        const header = document.createElement('div'); header.className = 'sps-calendar-header';
        const title = document.createElement('strong'); title.textContent = month.toLocaleDateString('en', {month:'long', year:'numeric'}); title.setAttribute('aria-live','polite');
        header.append(button('‹','Previous month', () => { month.setMonth(month.getMonth()-1); draw(1); }), title, button('›','Next month', () => { month.setMonth(month.getMonth()+1); draw(1); }));
        panel.append(header);
        const grid = document.createElement('div'); grid.className = 'sps-calendar-grid';
        ['Su','Mo','Tu','We','Th','Fr','Sa'].forEach(day => {const node = document.createElement('span'); node.textContent = day; node.className='sps-calendar-weekday'; grid.append(node);});
        const offset = new Date(month.getFullYear(),month.getMonth(),1).getDay();
        for(let i=0;i<offset;i++) grid.append(document.createElement('span'));
        const count = new Date(month.getFullYear(),month.getMonth()+1,0).getDate();
        for(let day=1;day<=count;day++) {
          const date = new Date(month.getFullYear(),month.getMonth(),day), key=iso(date);
          const node = button(String(day),date.toLocaleDateString('en',{dateStyle:'full'}), () => { selected=key; commit(); draw(day); });
          node.dataset.day=String(day); node.setAttribute('aria-pressed',String(key===selected));
          if(key===iso(new Date())) node.setAttribute('aria-current','date');
          node.disabled = !!((input.min && key < input.min.slice(0,10)) || (input.max && key > input.max.slice(0,10)));
          node.addEventListener('keydown', event => {
            const delta={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}[event.key];
            if(delta) { event.preventDefault(); const next=new Date(date); next.setDate(day+delta); month=new Date(next.getFullYear(),next.getMonth(),1); draw(next.getDate()); }
          });
          grid.append(node);
        }
        panel.append(grid);
        const timeLabel = document.createElement('label'); timeLabel.className='sps-calendar-time'; timeLabel.textContent='Time';
        time=document.createElement('input'); time.type='text'; time.inputMode='numeric'; time.placeholder='HH:mm'; time.pattern='(?:[01][0-9]|2[0-3]):[0-5][0-9]'; time.value=rememberedTime;
        time.addEventListener('input', () => {if(time.checkValidity() && time.value) commit();}); timeLabel.append(time); panel.append(timeLabel);
        const footer=document.createElement('div'); footer.className='sps-calendar-footer';
        footer.append(button('Clear','Clear date',()=>{input.value=''; input.setCustomValidity(''); input.dispatchEvent(new Event('change',{bubbles:true})); close(true);}),button('Today','Choose today',()=>{selected=iso(new Date()); month=new Date(); month.setDate(1); commit(); draw(new Date().getDate());}),button('Done',null,()=>{if(time.reportValidity() && time.value) {commit(); if(input.reportValidity()) close(true);}}));
        panel.append(footer);
        if(focusDay) panel.querySelector(`[data-day="${focusDay}"]`)?.focus({preventScroll:true});
      };
      listen(trigger,'click',()=>{
        if(active===control) {close(); return;}
        const date=new Date(input.value || Date.now()); month=Number.isFinite(date.getTime())?date:new Date(); month.setDate(1);
        selected=input.value.slice(0,10); time=null; draw(); open(control);
        (panel.querySelector('[aria-pressed="true"]') || panel.querySelector('[aria-current="date"]') || panel.querySelector('[data-day]:not(:disabled)'))?.focus({preventScroll:true});
      });
      validate();
      return () => {input.type='datetime-local'; input.setCustomValidity(''); for(const [key,value] of [['placeholder',oldPlaceholder],['pattern',oldPattern]]) {if(value===null) input.removeAttribute(key); else input.setAttribute(key,value);} wrapper.before(input); wrapper.remove(); panel.remove();};
    };
    const scan = () => {
      for(const [input, cleanup] of cleanups) if(!input.isConnected) {if(active?.trigger && !active.trigger.isConnected) close(); cleanup(); cleanups.delete(input);}
      root.querySelectorAll(selector).forEach(input => {if(!cleanups.has(input)) cleanups.set(input,input.tagName==='SELECT'?enhanceSelect(input):enhanceDate(input));});
    };
    listen(document,'sps:controls-close',()=>close());
    listen(document,'pointerdown',event=>{if(active && !active.panel.contains(event.target) && !active.trigger.contains(event.target)) close();});
    listen(document,'keydown',event=>{
      if(!active) return;
      if(event.key==='Escape') {event.preventDefault(); event.stopImmediatePropagation(); close(true);}
      if(event.key==='Tab' && active.calendar) {
        const nodes=[...active.panel.querySelectorAll('button:not(:disabled),input')];
        if((event.shiftKey && document.activeElement===nodes[0]) || (!event.shiftKey && document.activeElement===nodes.at(-1))) {event.preventDefault(); close(true);}
      }
    });
    listen(window,'resize',place); document.addEventListener('scroll',event=>{if(active && !active.panel.contains(event.target)) place();},{capture:true,signal});
    listen(root,'reset',()=>queueMicrotask(scan));
    const observer=new MutationObserver(scan); scan(); observer.observe(root,{childList:true,subtree:true});
    return () => {close(); observer.disconnect(); listeners.abort(); for(const cleanup of cleanups.values()) cleanup(); cleanups.clear();};
  };
  window.SPSControls = {mount};
})();
