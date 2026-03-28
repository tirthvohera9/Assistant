export function extractEntities(intentData) {
  return {
    people: Array.isArray(intentData.people) ? intentData.people.filter(p => p && p.trim()) : [],
    projects: Array.isArray(intentData.projects) ? intentData.projects.filter(p => p && p.trim()) : [],
    topics: Array.isArray(intentData.topics) ? intentData.topics.filter(t => t && t.trim()) : []
  };
}

export function hasEntities(intentData) {
  const { people, projects, topics } = extractEntities(intentData);
  return people.length > 0 || projects.length > 0 || topics.length > 0;
}
