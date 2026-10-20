# GAINAKO

Application cartographique de suivi des champs et d’aide à la décision agricole.

## Confidentialité

GAINAKO utilise une connexion Supabase. Le code source peut rester dans un dépôt GitHub privé ; GitHub Pro autorise Pages depuis un dépôt privé, mais l’adresse Pages et l’interface du site sont publiques. Les coordonnées, contours et observations sont chargés depuis Supabase uniquement après connexion.

La sécurité des données dépend des règles RLS du fichier `supabase/schema.sql` et des adhésions dans `field_members`. N’ajoutez jamais de coordonnées privées au HTML, au JavaScript ou à la configuration du site. La clé Publishable de Supabase est destinée à être utilisée dans le navigateur ; ne mettez jamais une clé `service_role` ou une clé secrète dans le site.

Après connexion, les demandes de tuiles et de métadonnées transmettent la zone consultée aux fournisseurs cartographiques (notamment Esri), qui reçoivent aussi les informations réseau nécessaires pour servir ces images.

## Mise en service

1. Créez un projet Supabase Free, puis exécutez `supabase/schema.sql` dans son SQL Editor.
2. Dans Authentication > Users, créez les comptes autorisés. GAINAKO ne propose pas d’inscription publique.
3. Dans la table `fields`, ajoutez la parcelle : son nom, son centre et son contour sous forme de tableau JSON `[[latitude, longitude], ...]`. Gardez ces données dans Supabase, pas dans les fichiers du dépôt. La colonne `boundary` attend un tableau de points ; chaque point est `[latitude, longitude]`.
4. Vérifiez que les adresses des comptes sont confirmées. Dans le SQL Editor, récupérez l’identifiant de la parcelle dans `public.fields` et les UUID des comptes dans `auth.users`, puis ajoutez-les à `field_members` en remplaçant les valeurs ci-dessous :

   ```sql
   insert into public.field_members (field_id, user_id)
   select 'UUID_DE_LA_PARCELLE'::uuid, users.id
   from auth.users as users
   where users.email in ('EMAIL_AUTORISE_1', 'EMAIL_AUTORISE_2');
   ```

   Sans cette adhésion, un compte ne peut pas lire la parcelle.
5. Dans `supabase-config.js`, renseignez l’URL du projet et sa clé Publishable depuis les paramètres/API Keys Supabase. Cette configuration est visible dans le navigateur ; les politiques RLS doivent rester activées.
6. Activez GitHub Pages dans les paramètres du dépôt, depuis la branche `main` et le dossier racine. Le dépôt source peut rester privé avec GitHub Pro ; le site publié, lui, est public. Les visiteurs non connectés ne reçoivent pas les données de la parcelle.

Les observations et modifications du contour sont synchronisées dans Supabase entre les appareils. L’export et l’import JSON restent disponibles pour faire une copie ou transférer d’anciennes observations. L’import ajoute ou met à jour les observations correspondantes et remplace le contour ; il ne supprime pas les autres observations déjà présentes.

## Offre gratuite et limites

GitHub Pages sert les fichiers statiques sans facturation à l’usage de l’application. Supabase Free inclut l’authentification et une base de données à 0 $, dans les limites du plan. Les projets gratuits peuvent être mis en pause après une semaine d’inactivité ; les quotas et conditions des fournisseurs peuvent évoluer. Une connexion Internet est requise pour se connecter, synchroniser les données et charger les cartes.

La PWA met en cache la coquille du site, pas la carte ni les données privées. Le panneau Sentinel‑2/NDVI est informatif : aucune analyse de télédétection n’est encore connectée. La surface affichée est calculée à partir du contour enregistré, pas une mesure cadastrale.
