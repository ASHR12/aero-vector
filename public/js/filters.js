// Search, Airline Filtering, Altitude Legend & Region Navigation
class FilterManager {
  constructor(mapInstance, flightLayer) {
    this.map = mapInstance;
    this.flightLayer = flightLayer;

    this.currentFilters = {
      airline: '',
      minAlt: undefined,
      maxAlt: undefined,
      search: '',
      category: 'all'
    };

    this.activeAltitudeBand = null;
    this.airlineCounts = new Map();

    this.initElements();
    this.setupListeners();
  }

  initElements() {
    this.searchInput = document.getElementById('search-flight-input');
    this.btnClearSearch = document.getElementById('btn-clear-search');
    this.airlineChipsContainer = document.getElementById('airline-chips');
    this.altitudeLegendContainer = document.getElementById('altitude-legend');
    this.regionSelect = document.getElementById('region-selector');
    this.btnFilterToggle = document.getElementById('btn-filter-toggle');
    this.advancedFilterModal = document.getElementById('filter-modal');
    this.btnCloseFilterModal = document.getElementById('btn-close-filter-modal');
    this.btnResetFilters = document.getElementById('btn-reset-filters');
    this.sliderMinAlt = document.getElementById('slider-min-alt');
    this.sliderMaxAlt = document.getElementById('slider-max-alt');
    this.valMinAlt = document.getElementById('val-min-alt');
    this.valMaxAlt = document.getElementById('val-max-alt');
    this.airlineSelectDropdown = document.getElementById('airline-select-dropdown');
    this.categoryPills = document.querySelectorAll('.category-pill');

    this.activeFilterBanner = document.getElementById('active-filter-banner');
    this.activeFilterLabel = document.getElementById('active-filter-label');
    this.activeFilterValue = document.getElementById('active-filter-value');
    this.activeFilterCount = document.getElementById('active-filter-count');
    this.btnClearActiveFilter = document.getElementById('btn-clear-active-filter');
    this.emptyFilterAlert = document.getElementById('empty-filter-alert');
    this.emptyFilterReason = document.getElementById('empty-filter-reason');
    this.btnEmptyReset = document.getElementById('btn-empty-reset');
  }

  setupListeners() {
    // Search input with debounce
    let debounceTimer;
    if (this.searchInput) {
      this.searchInput.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        const val = e.target.value.trim();
        if (this.btnClearSearch) {
          this.btnClearSearch.style.display = val ? 'flex' : 'none';
        }
        debounceTimer = setTimeout(() => {
          this.currentFilters.search = val;
          this.applyFilters();
        }, 250);
      });

      // Shortcut '/' to focus search
      window.addEventListener('keydown', (e) => {
        if (e.key === '/' && document.activeElement !== this.searchInput) {
          e.preventDefault();
          this.searchInput.focus();
        } else if (e.key === 'Escape') {
          if (this.searchInput === document.activeElement) {
            this.searchInput.blur();
          } else {
            this.clearFilters();
          }
        }
      });
    }

    if (this.btnClearSearch) {
      this.btnClearSearch.addEventListener('click', () => {
        this.searchInput.value = '';
        this.btnClearSearch.style.display = 'none';
        this.currentFilters.search = '';
        this.applyFilters();
      });
    }

    // Quick Airline Chips (Supports clicking active chip to toggle off)
    if (this.airlineChipsContainer) {
      this.airlineChipsContainer.addEventListener('click', (e) => {
        const chip = e.target.closest('.airline-chip');
        if (!chip) return;

        const code = chip.dataset.airline || '';
        this.setAirlineFilter(code, chip);
      });
    }

    // Altitude Legend Band Toggles (Supports clicking active band to toggle off)
    if (this.altitudeLegendContainer) {
      this.altitudeLegendContainer.addEventListener('click', (e) => {
        const item = e.target.closest('.ribbon-band') || e.target.closest('.legend-item');
        if (!item) return;

        const band = item.dataset.band;
        this.toggleAltitudeBand(band, item);
      });
    }

    // Region / Corridor Presets
    const corridorButtons = document.querySelectorAll('.corridor-btn, .region-btn');
    corridorButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const region = btn.dataset.region;
        this.jumpToRegion(region);
        corridorButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Altitude Sliders
    if (this.sliderMinAlt && this.sliderMaxAlt) {
      const updateSliderUI = () => {
        const minVal = parseInt(this.sliderMinAlt.value);
        const maxVal = parseInt(this.sliderMaxAlt.value);
        if (this.valMinAlt) this.valMinAlt.textContent = `${minVal.toLocaleString()} FT`;
        if (this.valMaxAlt) this.valMaxAlt.textContent = `${maxVal.toLocaleString()} FT`;
        this.currentFilters.minAlt = minVal > 0 ? minVal : undefined;
        this.currentFilters.maxAlt = maxVal < 50000 ? maxVal : undefined;
        this.applyFilters();
      };

      this.sliderMinAlt.addEventListener('input', updateSliderUI);
      this.sliderMaxAlt.addEventListener('input', updateSliderUI);
    }

    // Category Pills (Supports toggle off back to 'all')
    if (this.categoryPills) {
      this.categoryPills.forEach(pill => {
        pill.addEventListener('click', () => {
          const cat = pill.dataset.category || 'all';
          if (pill.classList.contains('active') && cat !== 'all') {
            // Toggle off
            this.categoryPills.forEach(p => p.classList.remove('active'));
            this.categoryPills[0].classList.add('active');
            this.currentFilters.category = 'all';
          } else {
            this.categoryPills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            this.currentFilters.category = cat;
          }
          if (window.aviationAudio) window.aviationAudio.playChirp(700, 0.03, 0.05);
          this.applyFilters();
        });
      });
    }

    // Filter Modal Open/Close
    if (this.btnFilterToggle && this.advancedFilterModal) {
      this.btnFilterToggle.addEventListener('click', () => {
        this.advancedFilterModal.classList.toggle('open');
      });
    }

    if (this.btnCloseFilterModal && this.advancedFilterModal) {
      this.btnCloseFilterModal.addEventListener('click', () => {
        this.advancedFilterModal.classList.remove('open');
      });
    }

    if (this.btnResetFilters) {
      this.btnResetFilters.addEventListener('click', () => {
        this.clearFilters();
      });
    }

    // Active Filter Clear Button
    if (this.btnClearActiveFilter) {
      this.btnClearActiveFilter.addEventListener('click', () => {
        this.clearFilters();
      });
    }

    // Empty State Alert Reset Button
    if (this.btnEmptyReset) {
      this.btnEmptyReset.addEventListener('click', () => {
        this.clearFilters();
      });
    }

    // Populate dynamic airline dropdown when airlines list loads
    window.flightAPI.on('airlines', (airlines) => {
      this.populateAirlineDropdown(airlines);
      this.updateAirlineChipCounts(airlines);
    });

    // Update stats in altitude legend & handle empty state alert
    window.flightAPI.on('stats', (stats) => {
      this.updateAltitudeLegendCounts(stats.altBrackets);
    });

    window.flightAPI.on('flights', (data) => {
      this.updateFilterStatusUI(data);
    });
  }

  setAirlineFilter(code, chipElement) {
    if (this.currentFilters.airline === code && code !== '') {
      // Toggle off back to all flights
      this.currentFilters.airline = '';
      code = '';
    } else {
      this.currentFilters.airline = code;
    }

    const chips = this.airlineChipsContainer.querySelectorAll('.airline-chip');
    chips.forEach(c => {
      if ((c.dataset.airline || '') === code) {
        c.classList.add('active');
      } else {
        c.classList.remove('active');
      }
    });

    if (window.aviationAudio) window.aviationAudio.playChirp(700, 0.03, 0.05);
    this.applyFilters();
  }

  toggleAltitudeBand(band, itemElement) {
    const items = this.altitudeLegendContainer.querySelectorAll('.ribbon-band, .legend-item');

    if (this.activeAltitudeBand === band) {
      // Deactivate
      this.activeAltitudeBand = null;
      this.currentFilters.minAlt = undefined;
      this.currentFilters.maxAlt = undefined;
      items.forEach(i => i.classList.remove('active'));
    } else {
      this.activeAltitudeBand = band;
      items.forEach(i => i.classList.remove('active'));
      itemElement.classList.add('active');

      if (band === 'low') {
        this.currentFilters.minAlt = 0;
        this.currentFilters.maxAlt = 9999;
      } else if (band === 'mid') {
        this.currentFilters.minAlt = 10000;
        this.currentFilters.maxAlt = 24999;
      } else if (band === 'cruise') {
        this.currentFilters.minAlt = 25000;
        this.currentFilters.maxAlt = 34999;
      } else if (band === 'high') {
        this.currentFilters.minAlt = 35000;
        this.currentFilters.maxAlt = 40000;
      } else if (band === 'strat') {
        this.currentFilters.minAlt = 40001;
        this.currentFilters.maxAlt = 999999;
      }
    }

    if (window.aviationAudio) window.aviationAudio.playChirp(800, 0.03, 0.05);
    this.applyFilters();
  }

  jumpToRegion(region) {
    if (window.aviationAudio) window.aviationAudio.playChirp(900, 0.04, 0.06);

    const base = this.map.baseScale;
    switch (region) {
      case 'global':
        this.map.flyTo(0, 20, base);
        break;
      case 'north-america':
        this.map.flyTo(-98, 39, base * 2.2);
        break;
      case 'europe':
        this.map.flyTo(12, 50, base * 2.6);
        break;
      case 'east-asia':
        this.map.flyTo(115, 32, base * 2.3);
        break;
      case 'middle-east':
        this.map.flyTo(48, 26, base * 2.5);
        break;
      case 'transatlantic':
        this.map.flyTo(-40, 45, base * 1.7);
        break;
      case 'south-america':
        this.map.flyTo(-60, -15, base * 2.0);
        break;
      case 'oceania':
        this.map.flyTo(135, -25, base * 2.1);
        break;
    }
  }

  populateAirlineDropdown(airlines) {
    if (!this.airlineSelectDropdown) return;
    this.airlineSelectDropdown.innerHTML = '<option value="">All Airlines (Global Network)</option>';

    for (const al of airlines) {
      const opt = document.createElement('option');
      opt.value = al.code || al.name;
      opt.textContent = `${al.name} (${al.count} active)`;
      this.airlineSelectDropdown.appendChild(opt);
    }

    this.airlineSelectDropdown.addEventListener('change', (e) => {
      this.currentFilters.airline = e.target.value;
      this.applyFilters();
    });
  }

  updateAirlineChipCounts(airlines) {
    if (!this.airlineChipsContainer || !Array.isArray(airlines)) return;
    const countMap = new Map();
    for (const al of airlines) {
      if (al.code) countMap.set(al.code.toUpperCase(), al.count);
    }

    const chips = this.airlineChipsContainer.querySelectorAll('.airline-chip');
    chips.forEach(chip => {
      const code = (chip.dataset.airline || '').toUpperCase();
      if (!code) return; // "All Global Flights" chip
      const count = countMap.get(code) || 0;
      const baseName = chip.textContent.replace(/\s*\(\d+\)$/, '').trim();
      chip.innerHTML = `${baseName} <span class="chip-count">(${count})</span>`;
    });
  }

  updateAltitudeLegendCounts(altBrackets) {
    if (!altBrackets) return;
    const elLow = document.getElementById('count-alt-low');
    const elMid = document.getElementById('count-alt-mid');
    const elCruise = document.getElementById('count-alt-cruise');
    const elHigh = document.getElementById('count-alt-high');
    const elStrat = document.getElementById('count-alt-strat');

    if (elLow && altBrackets.low !== undefined) elLow.textContent = altBrackets.low.toLocaleString();
    if (elMid && altBrackets.mid !== undefined) elMid.textContent = altBrackets.mid.toLocaleString();
    if (elCruise && altBrackets.cruise !== undefined) elCruise.textContent = altBrackets.cruise.toLocaleString();
    if (elHigh && altBrackets.high !== undefined) elHigh.textContent = altBrackets.high.toLocaleString();
    if (elStrat && altBrackets.strat !== undefined) elStrat.textContent = altBrackets.strat.toLocaleString();
  }

  updateFilterStatusUI(data) {
    const isFilterActive = !!(
      this.currentFilters.airline ||
      (this.currentFilters.category && this.currentFilters.category !== 'all') ||
      this.currentFilters.minAlt !== undefined ||
      this.currentFilters.maxAlt !== undefined ||
      this.currentFilters.search
    );

    if (isFilterActive) {
      const parts = [];
      if (this.currentFilters.airline) parts.push(`Airline: ${this.currentFilters.airline}`);
      if (this.currentFilters.category && this.currentFilters.category !== 'all') parts.push(`Category: ${this.currentFilters.category.toUpperCase()}`);
      if (this.currentFilters.minAlt !== undefined || this.currentFilters.maxAlt !== undefined) {
        parts.push(`Alt: ${this.currentFilters.minAlt || 0}-${this.currentFilters.maxAlt || '50k+'}ft`);
      }
      if (this.currentFilters.search) parts.push(`Search: "${this.currentFilters.search}"`);

      const desc = parts.join(' • ');
      if (this.activeFilterBanner) {
        this.activeFilterValue.textContent = desc;
        this.activeFilterCount.textContent = `${data.count} / ${data.totalGlobal || data.count}`;
        this.activeFilterBanner.style.display = 'block';
      }

      // Check if filter returned 0 flights
      if (data.count === 0 && (data.totalGlobal || 0) > 0) {
        if (this.emptyFilterAlert) {
          this.emptyFilterReason.textContent = `No active aircraft match criteria: [ ${desc} ]. Total ${data.totalGlobal.toLocaleString()} global aircraft online.`;
          this.emptyFilterAlert.style.display = 'block';
        }
      } else if (this.emptyFilterAlert) {
        this.emptyFilterAlert.style.display = 'none';
      }
    } else {
      if (this.activeFilterBanner) this.activeFilterBanner.style.display = 'none';
      if (this.emptyFilterAlert) this.emptyFilterAlert.style.display = 'none';
    }
  }

  applyFilters() {
    window.flightAPI.fetchFlights(this.currentFilters);
  }

  clearFilters() {
    this.currentFilters = {
      airline: '',
      minAlt: undefined,
      maxAlt: undefined,
      search: '',
      category: 'all'
    };
    this.activeAltitudeBand = null;

    if (this.searchInput) this.searchInput.value = '';
    if (this.btnClearSearch) this.btnClearSearch.style.display = 'none';
    if (this.sliderMinAlt) this.sliderMinAlt.value = 0;
    if (this.sliderMaxAlt) this.sliderMaxAlt.value = 50000;
    if (this.valMinAlt) this.valMinAlt.textContent = '0 FT';
    if (this.valMaxAlt) this.valMaxAlt.textContent = '50,000+ FT';
    if (this.airlineSelectDropdown) this.airlineSelectDropdown.value = '';

    const chips = this.airlineChipsContainer.querySelectorAll('.airline-chip');
    chips.forEach(c => {
      if (c.dataset.airline === '') c.classList.add('active');
      else c.classList.remove('active');
    });

    const legendItems = this.altitudeLegendContainer.querySelectorAll('.ribbon-band, .legend-item');
    legendItems.forEach(i => i.classList.remove('active'));

    if (this.categoryPills) {
      this.categoryPills.forEach((p, idx) => {
        if (idx === 0) p.classList.add('active');
        else p.classList.remove('active');
      });
    }

    if (this.activeFilterBanner) this.activeFilterBanner.style.display = 'none';
    if (this.emptyFilterAlert) this.emptyFilterAlert.style.display = 'none';

    if (window.aviationAudio) window.aviationAudio.playChirp(600, 0.04, 0.05);
    this.applyFilters();
  }
}

window.FilterManager = FilterManager;
