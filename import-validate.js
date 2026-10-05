// Pure validation for the trip import payload — the inverse of GET /api/export.
// No fs, no side effects: given a parsed JSON payload, decide whether it is safe
// to import and describe what it contains. Writing the data is someone else's job.

const IMPORTABLE_KEYS = ['trip', 'accommodations', 'flights', 'documents', 'flighty'];
const SKIPPED_KEYS = ['budget', 'wishlist'];
const MAX_ISSUES = 20;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A document filename is joined onto the documents directory when the file is
// served or deleted, so an imported one must be a plain basename: the leading
// character class rules out '.' and '..', and no '/', '\' or NUL can pass.
const SAFE_FILENAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*)$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function validateImport(payload) {
  const issues = [];
  let truncated = false;
  const summary = { stores: {}, skipped: [], unknown: [] };

  // Records an issue, respecting the MAX_ISSUES cap. Returns true when the
  // issue was actually recorded, false when the cap was already hit (in
  // which case the caller should stop looking for more in that area — we
  // already know enough to report truncated: true).
  function addIssue(path, message) {
    if (issues.length < MAX_ISSUES) {
      issues.push({ path, message });
      return true;
    }
    truncated = true;
    return false;
  }

  if (!isPlainObject(payload)) {
    addIssue('', 'Payload must be an object');
    return { ok: issues.length === 0, issues, truncated, summary };
  }

  const keys = Object.keys(payload);
  const presentImportable = [];

  for (const key of keys) {
    if (IMPORTABLE_KEYS.includes(key)) {
      presentImportable.push(key);
    } else if (SKIPPED_KEYS.includes(key)) {
      summary.skipped.push(key);
    } else {
      summary.unknown.push(key);
      addIssue(key, 'Unknown key');
    }
  }

  if (presentImportable.length === 0) {
    addIssue('', 'Payload must contain at least one importable key');
  }

  const hasFlighty = keys.includes('flighty');
  const hasFlights = keys.includes('flights');
  if (hasFlighty !== hasFlights) {
    addIssue('', 'flighty and flights must both be present or both be absent');
  }

  // Validates a list of items against `validateItem`, stopping early once
  // the issue cap has been hit rather than scanning the whole array.
  function validateItems(list, basePath, validateItem) {
    for (let i = 0; i < list.length; i++) {
      if (truncated) break;
      validateItem(list[i], `${basePath}[${i}]`);
    }
  }

  function checkDuplicateIds(list, basePath) {
    const seen = new Set();
    for (let i = 0; i < list.length; i++) {
      if (truncated) break;
      const item = list[i];
      if (!isPlainObject(item) || !isNonEmptyString(item.id)) continue; // reported elsewhere
      if (seen.has(item.id)) {
        addIssue(`${basePath}[${i}].id`, 'Duplicate id');
      } else {
        seen.add(item.id);
      }
    }
  }

  function validateAccommodation(item, path) {
    if (!isPlainObject(item)) { addIssue(path, 'Must be an object'); return; }
    if (!isNonEmptyString(item.id)) addIssue(`${path}.id`, 'id is required');
    const checkInValid = isValidDate(item.check_in);
    const checkOutValid = isValidDate(item.check_out);
    if (!checkInValid) addIssue(`${path}.check_in`, 'check_in must be a valid YYYY-MM-DD date');
    if (!checkOutValid) addIssue(`${path}.check_out`, 'check_out must be a valid YYYY-MM-DD date');
    // Strictly before, matching the server's own validStayDates: POST/PUT
    // /api/accommodations refuse a zero-night stay, so the import must not be
    // the one back door that persists one (it would never match the
    // check_in <= date < check_out window the weather and AI-suggestion code
    // use, so the stay would exist but resolve to nothing).
    if (checkInValid && checkOutValid && item.check_in >= item.check_out) {
      addIssue(path, 'check_in must be before check_out');
    }
  }

  function validateCalendarEntry(item, path) {
    if (!isPlainObject(item)) { addIssue(path, 'Must be an object'); return; }
    if (!isNonEmptyString(item.id)) addIssue(`${path}.id`, 'id is required');
    if (!isValidDate(item.date)) addIssue(`${path}.date`, 'date must be a valid YYYY-MM-DD date');
    if (!isNonEmptyString(item.type)) addIssue(`${path}.type`, 'type is required');
  }

  function validateTrain(item, path) {
    if (!isPlainObject(item)) { addIssue(path, 'Must be an object'); return; }
    if (!isNonEmptyString(item.id)) addIssue(`${path}.id`, 'id is required');
  }

  function validateFlight(item, path) {
    if (!isPlainObject(item)) { addIssue(path, 'Must be an object'); return; }
    if (!isNonEmptyString(item.id)) addIssue(`${path}.id`, 'id is required');
    if (!isNonEmptyString(item.flightNumber)) addIssue(`${path}.flightNumber`, 'flightNumber is required');
    if (!isValidDate(item.departureDate)) addIssue(`${path}.departureDate`, 'departureDate must be a valid YYYY-MM-DD date');
  }

  function validateDocument(item, path) {
    if (!isPlainObject(item)) { addIssue(path, 'Must be an object'); return; }
    if (!isNonEmptyString(item.id)) addIssue(`${path}.id`, 'id is required');
    if (!isNonEmptyString(item.title)) addIssue(`${path}.title`, 'title is required');
    if (!isNonEmptyString(item.filename)) {
      addIssue(`${path}.filename`, 'filename is required');
    } else if (!SAFE_FILENAME_RE.test(item.filename)) {
      addIssue(`${path}.filename`, 'filename must be a plain file name (no path separators)');
    }
    const validFromValid = isValidDate(item.valid_from);
    const validToValid = isValidDate(item.valid_to);
    if (!validFromValid) addIssue(`${path}.valid_from`, 'valid_from must be a valid YYYY-MM-DD date');
    if (!validToValid) addIssue(`${path}.valid_to`, 'valid_to must be a valid YYYY-MM-DD date');
    if (validFromValid && validToValid && item.valid_from > item.valid_to) {
      addIssue(path, 'valid_from must be on or before valid_to');
    }
  }

  if (presentImportable.includes('trip')) {
    const trip = payload.trip;
    if (!isPlainObject(trip)) {
      addIssue('trip', 'trip must be an object');
      summary.stores.trip = { calendar: 0, trains: 0 };
    } else {
      let calendarCount = 0;
      let trainsCount = 0;

      // The trip store is written verbatim, and nothing downstream backfills a
      // missing key: the server pushes onto data.calendar and the frontend
      // dereferences calendar and trip.startDate unguarded, so a partial trip
      // store breaks the running app. All three keys are therefore required —
      // every genuine export carries them.
      if (Array.isArray(trip.calendar)) {
        calendarCount = trip.calendar.length;
      } else {
        addIssue('trip.calendar', 'trip.calendar is required and must be an array');
      }

      if (Array.isArray(trip.trains)) {
        trainsCount = trip.trains.length;
      } else {
        addIssue('trip.trains', 'trip.trains is required and must be an array');
      }

      if (!isPlainObject(trip.trip)) {
        addIssue('trip.trip', 'trip.trip must be an object');
      } else {
        const startValid = isValidDate(trip.trip.startDate);
        const endValid = isValidDate(trip.trip.endDate);
        if (!startValid) addIssue('trip.trip.startDate', 'startDate must be a valid YYYY-MM-DD date');
        if (!endValid) addIssue('trip.trip.endDate', 'endDate must be a valid YYYY-MM-DD date');
        if (startValid && endValid && trip.trip.startDate > trip.trip.endDate) {
          addIssue('trip.trip', 'startDate must be on or before endDate');
        }
      }

      summary.stores.trip = { calendar: calendarCount, trains: trainsCount };

      if (Array.isArray(trip.calendar)) {
        validateItems(trip.calendar, 'trip.calendar', validateCalendarEntry);
        checkDuplicateIds(trip.calendar, 'trip.calendar');
      }
      if (Array.isArray(trip.trains)) {
        validateItems(trip.trains, 'trip.trains', validateTrain);
        checkDuplicateIds(trip.trains, 'trip.trains');
      }
    }
  }

  if (presentImportable.includes('accommodations')) {
    const accommodations = payload.accommodations;
    if (!Array.isArray(accommodations)) {
      addIssue('accommodations', 'accommodations must be an array');
      summary.stores.accommodations = 0;
    } else {
      summary.stores.accommodations = accommodations.length;
      validateItems(accommodations, 'accommodations', validateAccommodation);
      checkDuplicateIds(accommodations, 'accommodations');
    }
  }

  if (presentImportable.includes('flights')) {
    const flights = payload.flights;
    if (!Array.isArray(flights)) {
      addIssue('flights', 'flights must be an array');
      summary.stores.flights = 0;
    } else {
      summary.stores.flights = flights.length;
      validateItems(flights, 'flights', validateFlight);
      checkDuplicateIds(flights, 'flights');
    }
  }

  if (presentImportable.includes('documents')) {
    const documents = payload.documents;
    if (!Array.isArray(documents)) {
      addIssue('documents', 'documents must be an array');
      summary.stores.documents = 0;
    } else {
      summary.stores.documents = documents.length;
      validateItems(documents, 'documents', validateDocument);
      checkDuplicateIds(documents, 'documents');
    }
  }

  if (presentImportable.includes('flighty')) {
    const flighty = payload.flighty;
    if (typeof flighty !== 'string') {
      addIssue('flighty', 'flighty must be a string');
      summary.stores.flighty = 0;
    } else {
      summary.stores.flighty = flighty.length;
    }
  }

  return { ok: issues.length === 0, issues, truncated, summary };
}

module.exports = { validateImport, IMPORTABLE_KEYS, SKIPPED_KEYS, MAX_ISSUES };
