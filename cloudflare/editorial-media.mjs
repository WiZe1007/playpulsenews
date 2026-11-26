const directory='/assets/editorial/';
const topics={
 'Політики':'review','Практика Play Console':'review','Магазин':'release','Публікація':'release',
 'Гемблінг':'games','Ігри':'development','Монетизація':'development','API':'development'
};
const dedicated=new Map([['practice-no-deposit-bonuses-backup-content','backup']]);
export const editorialAssetPaths=new Set([...Object.values(topics),...dedicated.values()].map(name=>directory+name+'.jpg'));

export function editorialImageURL(item,origin){
 if(!origin)return null;
 const topic=dedicated.get(item.id)||topics[item.category]||'development';
 return new URL(directory+topic+'.jpg',origin).href;
}
