class AuthDirectoryUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthDirectoryUnavailable';
  }
}

function createAuthStudentDirectory({
  baseUrl = process.env.AUTH_SERVICE_URL,
  internalServiceToken = process.env.INTERNAL_SERVICE_TOKEN,
  fetchImpl = globalThis.fetch,
} = {}) {
  function configuredBaseUrl() {
    if (!baseUrl || !internalServiceToken || typeof fetchImpl !== 'function') {
      throw new AuthDirectoryUnavailable('Auth student directory is not configured.');
    }
    return baseUrl.replace(/\/+$/, '');
  }

  async function request(path) {
    let response;
    try {
      response = await fetchImpl(`${configuredBaseUrl()}${path}`, {
        headers: { 'X-Internal-Service-Token': internalServiceToken },
      });
    } catch (err) {
      throw new AuthDirectoryUnavailable(`Auth student directory request failed: ${err.message}`);
    }

    if (response.status === 404) return null;
    if (response.status === 403) return { forbidden: true };
    if (!response.ok) {
      throw new AuthDirectoryUnavailable(`Auth student directory returned ${response.status}.`);
    }
    try {
      return await response.json();
    } catch {
      throw new AuthDirectoryUnavailable('Auth student directory returned invalid JSON.');
    }
  }

  return {
    async findStudentInSchool(studentId, schoolId) {
      const result = await request(
        `/api/auth/internal/students/${encodeURIComponent(studentId)}?schoolId=${encodeURIComponent(schoolId)}`,
      );
      if (!result) return null;
      if (result.forbidden) return result;
      if (result.studentId !== studentId || result.schoolId !== schoolId) {
        throw new AuthDirectoryUnavailable('Auth student directory returned an invalid student projection.');
      }
      return result;
    },
    async listStudentIdsInSchool(schoolId) {
      const result = await request(`/api/auth/internal/schools/${encodeURIComponent(schoolId)}/students`);
      if (!result) return [];
      if (!Array.isArray(result.studentIds) || !result.studentIds.every(id => typeof id === 'string')) {
        throw new AuthDirectoryUnavailable('Auth student directory returned an invalid student list.');
      }
      return result.studentIds;
    },
  };
}

const authStudentDirectory = createAuthStudentDirectory();

module.exports = { AuthDirectoryUnavailable, createAuthStudentDirectory, authStudentDirectory };
