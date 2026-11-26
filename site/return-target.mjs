const ARTICLE=/^[a-z0-9][a-z0-9-]{0,95}$/;
const TOPICS=new Set(['policies','publishing','monetization','games','store','api','gambling','play-console-practice']);

// Reflect only the small public feed-navigation contract, never arbitrary
// query parameters or a caller-provided destination origin.
export function feedReturnTarget(url){
 if(url.pathname!=='/')return '/';
 const params=url.searchParams;
 for(const key of params.keys())if(!['article','topic'].includes(key)||params.getAll(key).length!==1)return '/';
 const article=params.get('article'),topic=params.get('topic');
 if(article!==null&&!ARTICLE.test(article)||topic!==null&&!TOPICS.has(topic))return '/';
 const query=new URLSearchParams();
 if(article!==null)query.set('article',article);
 if(topic!==null)query.set('topic',topic);
 return query.size?'/?'+query.toString()+'#news':'/';
}
